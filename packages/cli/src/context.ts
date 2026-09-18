//! Resolving which room and which session a command means.
//!
//! Identity is scoped to the session, never to the working directory: two agents
//! in one checkout must not share a credential or consume each other's inbox. A
//! command that cannot tell them apart says so instead of picking one.

import {ProtocolError} from '@pairlobby/protocol';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import type {RoomEntry, SessionEntry} from '@pairlobby/client';

type ServerOptions = {server?: string | undefined; local?: boolean | undefined};

type RecipientParticipant = {participantId: string; displayName: string; revoked: boolean; left: boolean};

export const DEFAULT_LOCAL_SERVER = 'http://127.0.0.1:8790';

export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

export interface Selection {
    room: RoomEntry;
    session: SessionEntry;
    credential: string;
    client: PairLobbyClient;
}

export function resolveServer(options: ServerOptions): string {
    // One mechanism: an explicit URL, else the configured default, and --local is
    // only sugar for the loopback URL rather than a second code path.
    if (options.server && options.local) {
        throw new UsageError('use either --server or --local, not both');
    }
    if (options.server) {
        return options.server;
    }
    if (options.local) {
        return DEFAULT_LOCAL_SERVER;
    }
    return process.env['PAIRLOBBY_SERVER'] ?? DEFAULT_LOCAL_SERVER;
}

export function resolveRoom(store: LocalStore, reference?: string): RoomEntry {
    const wanted = reference ?? process.env['PAIRLOBBY_ROOM'];
    if (!wanted) {
        const sole = store.soleRoom();
        if (sole) {
            return sole;
        }
        const rooms = store.rooms();
        if (rooms.length === 0) {
            throw new UsageError('no rooms on this device yet; run "pairlobby create" or "pairlobby join <code>"');
        }
        throw new UsageError(`more than one room is active; pass --room with one of: ${rooms.map((entry) => entry.name).join(', ')}`);
    }
    const resolved = store.resolveRoom(wanted);
    if ('room' in resolved) {
        return resolved.room;
    }
    if ('ambiguous' in resolved) {
        throw new UsageError(`"${wanted}" matches several rooms: ${resolved.ambiguous.map((entry) => `${entry.name} (${entry.roomId})`).join(', ')}`);
    }
    throw new UsageError(`no room on this device matches "${wanted}"`);
}

export function resolveSession(room: RoomEntry, reference?: string): SessionEntry {
    const wanted = reference ?? process.env['PAIRLOBBY_SESSION'];
    if (wanted) {
        const match = room.sessions.find((session) => session.sessionId === wanted || session.participantId === wanted);
        if (!match) {
            throw new UsageError(`no session "${wanted}" in room ${room.name}`);
        }
        return match;
    }
    if (room.sessions.length === 1) {
        return room.sessions[0]!;
    }
    if (room.sessions.length === 0) {
        throw new UsageError(`this device has no session in room ${room.name}`);
    }
    const described = room.sessions.map((session) => `${session.displayName} (${session.sessionId})`).join(', ');
    throw new UsageError(`this device holds several sessions in ${room.name}; pass --session with one of: ${described}`);
}

export function select(store: LocalStore, roomRef?: string, sessionRef?: string): Selection {
    const room = resolveRoom(store, roomRef);
    const session = resolveSession(room, sessionRef);
    const credential = store.credential(room.roomId, session.sessionId);
    if (!credential) {
        throw new UsageError(`no credential stored for session ${session.sessionId}; rejoin the room`);
    }
    return {room, session, credential, client: new PairLobbyClient(room.serverUrl)};
}

export function controllerCredential(store: LocalStore, room: RoomEntry): string {
    const credential = store.credential(room.roomId, 'controller');
    if (!credential) {
        throw new UsageError(`this device does not hold the controller credential for ${room.name}`);
    }
    return credential;
}

/** Resolves a recipient by participant id or unambiguous display name. */
export function resolveRecipient(participants: RecipientParticipant[], reference: string): string {
    const byId = participants.find((participant) => participant.participantId === reference);
    if (byId) {
        return byId.participantId;
    }
    const active = participants.filter((participant) => !participant.revoked && !participant.left);
    const matches = active.filter((participant) => participant.displayName.toLowerCase() === reference.toLowerCase());
    if (matches.length === 1) {
        return matches[0]!.participantId;
    }
    if (matches.length > 1) {
        throw new ProtocolError(
            'invalid_request',
            `"${reference}" names ${matches.length} participants; use one of these ids: ${matches.map((participant) => participant.participantId).join(', ')}`
        );
    }
    throw new ProtocolError('invalid_request', `no active participant called "${reference}"; the room has: ${active.map((participant) => participant.displayName).join(', ')}`);
}

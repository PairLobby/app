import {PairLobbyClient} from '@pairlobby/client';
import type {LocalStore, RoomEntry, SessionEntry} from '@pairlobby/client';
import {ProtocolError} from '@pairlobby/protocol';
import type {RoomListEntry} from './render.js';
import {receiverConfiguration, receiverStatus, stopReceiver} from './receiver.js';
import {modelId, savedSessionModel} from './model-metadata.js';
import {UsageError} from './context.js';

export type ListColumn = {key: string; label: string; width: number};
export type ListSortValue = string | number | null;
export type ListRow = {id: string; roomId: string; sessionId?: string; values: Record<string, string>; sortValues: Record<string, ListSortValue>};
export type ListSort = {key: string; descending: boolean};
export type ListedSession = SessionEntry & {state: string; receiverState: string | null; reportedModel: string | null};
export type ListedRoom = Omit<RoomEntry, 'sessions'> & {sessions: ListedSession[]; reachable: boolean; error: string | null; live: RoomListEntry['snapshot'] | null};
export type RoomListJson = {count: number; rooms: ListedRoom[]};

export const ROOM_COLUMNS: ListColumn[] = [
    {key: 'name', label: 'Room', width: 26}, {key: 'state', label: 'State', width: 14},
    {key: 'agents', label: 'Agents', width: 8}, {key: 'people', label: 'People', width: 8},
    {key: 'sessions', label: 'Local sessions', width: 15}, {key: 'created', label: 'Created (UTC)', width: 25},
    {key: 'expires', label: 'Expires (UTC)', width: 25}, {key: 'id', label: 'Room ID', width: 30},
    {key: 'relay', label: 'Relay', width: 36}
];
export const SESSION_COLUMNS: ListColumn[] = [
    {key: 'name', label: 'Name', width: 24}, {key: 'kind', label: 'Kind', width: 8},
    {key: 'state', label: 'State', width: 16}, {key: 'receiver', label: 'Receiver', width: 16},
    {key: 'model', label: 'Model', width: 28}, {key: 'role', label: 'Role', width: 12},
    {key: 'joined', label: 'Joined (UTC)', width: 25}, {key: 'id', label: 'Session ID', width: 30}
];

/** Only snapshots: listing never joins, acknowledges messages, or starts model work. */
export async function loadRoomList(store: LocalStore, signal?: AbortSignal): Promise<RoomListEntry[]> {
    return Promise.all(store.rooms().map(async (room): Promise<RoomListEntry> => {
        const credentials = [...new Set([store.credential(room.roomId, 'controller'), ...room.sessions.map((session) => store.credential(room.roomId, session.sessionId))].filter((value): value is string => Boolean(value)))];
        const client = new PairLobbyClient(room.serverUrl, undefined, signal);
        let why = 'no_saved_credential';
        try {
            for (const credential of credentials) {
                try {
                    return {room, reachable: true, snapshot: await client.snapshot(room.roomId, credential)};
                } catch (error) {
                    why = error instanceof ProtocolError ? error.code : 'unreachable';
                    if (!['unauthorized', 'participant_revoked', 'room_locked'].includes(why) || signal?.aborted) {
                        break;
                    }
                }
            }
            return {room, reachable: false, why};
        } finally {
            client.closeLive();
        }
    }));
}

function roomState(entry: RoomListEntry): string {
    return entry.snapshot?.lifecycle ?? ({room_expired: 'expired', room_not_found: 'missing', unauthorized: 'no access', participant_revoked: 'no access', no_saved_credential: 'no credential'}[entry.why ?? ''] || 'unreachable');
}

export function roomRows(entries: RoomListEntry[]): ListRow[] {
    return entries.map((entry) => {
        const {room, snapshot} = entry;
        const active = snapshot?.participants.filter((person) => !person.left && !person.revoked);
        const agents = active?.filter((person) => person.kind === 'agent').length ?? null;
        const people = active?.filter((person) => person.kind === 'human').length ?? null;
        const created = snapshot?.createdAt ?? room.createdAt;
        const expires = snapshot ? snapshot.expiresAt : room.expiresAt;
        const values = {name: snapshot?.name ?? room.name, state: roomState(entry), agents: agents === null ? 'Unknown' : String(agents), people: people === null ? 'Unknown' : String(people), sessions: String(room.sessions.length), created: new Date(created).toISOString(), expires: expires === null ? 'Never' : new Date(expires).toISOString(), id: room.roomId, relay: room.serverUrl};
        return {id: room.roomId, roomId: room.roomId, values, sortValues: {...values, agents, people, sessions: room.sessions.length, created, expires: expires ?? Number.POSITIVE_INFINITY}};
    });
}

/** A room found on the network and open to it, which this device has not joined. */
export type NetworkRoom = {url: string; label: string; room: {roomId: string; name: string; createdAt: number; participantCount: number}};

export const NETWORK_STATE = 'on network';

/** Rows for rooms not saved here: the relay tells only a name, an age and a head count before joining. */
export function networkRows(found: NetworkRoom[]): ListRow[] {
    return found.map(({url, label, room}) => {
        const values = {name: room.name, state: NETWORK_STATE, agents: 'Unknown', people: `${room.participantCount} in room`, sessions: 'Not joined', created: new Date(room.createdAt).toISOString(), expires: 'Unknown', id: room.roomId, relay: label === url || label === 'local network' ? url : `${url} (${label})`};
        return {id: room.roomId, roomId: room.roomId, values, sortValues: {...values, agents: null, people: room.participantCount, sessions: 0, created: room.createdAt, expires: null}};
    });
}

/** An unanswered invitation to a hosted room: what the service tells before accepting. */
export type RoomInvite = {id: string; roomId: string; roomName: string; invitedBy: string; role: 'member' | 'guest'; agents: number; createdAt: number; expiresAt: number};

export const INVITED_STATE = 'invited';

/** Rows for rooms this account was invited into and has not answered; nothing from inside the room is known yet. */
export function invitationRows(invitations: RoomInvite[]): ListRow[] {
    return invitations.map((invitation) => {
        const values = {name: invitation.roomName, state: INVITED_STATE, agents: 'Unknown', people: `by ${invitation.invitedBy}`, sessions: 'Not joined', created: new Date(invitation.createdAt).toISOString(), expires: 'Unknown', id: invitation.roomId, relay: `answer by ${new Date(invitation.expiresAt).toISOString().slice(0, 10)}`};
        return {id: invitation.roomId, roomId: invitation.roomId, values, sortValues: {...values, agents: null, people: null, sessions: 0, created: invitation.createdAt, expires: null}};
    });
}

export function sessionRows(store: LocalStore, entry: RoomListEntry): ListRow[] {
    return entry.room.sessions.map((session) => {
        const member = entry.snapshot?.participants.find((person) => person.participantId === session.participantId);
        const config = session.kind === 'agent' ? receiverConfiguration(store, session.sessionId) : null;
        const receiver = config ? receiverStatus(store, session.sessionId) : null;
        const state = member ? member.revoked ? 'Removed' : member.left ? 'Left' : entry.snapshot?.lifecycle !== 'open' ? `Room ${entry.snapshot?.lifecycle}` : member.paused ? 'Paused' : member.muted ? 'Muted' : 'Joined' : 'Unknown';
        const threadId = receiver?.threadId || (!config || receiver?.state === 'stopped' ? session.conversationId : undefined);
        const runtime = config?.runtime ?? session.runtime;
        const reported = modelId(receiver?.model) ?? (runtime && threadId ? savedSessionModel({runtime, threadId, cwd: config?.cwd ?? session.cwd}) : undefined);
        const configured = config?.model ?? session.model;
        const model = session.kind === 'human' ? '—' : reported || (configured ? configured + '*' : threadId ? 'Not reported' : 'Not started');
        const role = member?.role ?? session.role;
        const values = {name: member?.displayName ?? session.displayName, kind: member?.kind ?? session.kind, state, receiver: receiver?.state ?? 'Not managed', model, role: role === 'controller' ? 'Admin' : role === 'guest' ? 'Observer' : 'Member', joined: new Date(session.joinedAt).toISOString(), id: session.sessionId};
        return {id: session.sessionId, roomId: entry.room.roomId, sessionId: session.sessionId, values, sortValues: {...values, joined: session.joinedAt}};
    });
}

/** Stable sorting; unknown values stay at the end in either direction. */
export function sortListRows(rows: ListRow[], sort: ListSort): ListRow[] {
    return [...rows].sort((left, right) => {
        const a = left.sortValues[sort.key] ?? null;
        const b = right.sortValues[sort.key] ?? null;
        if (a === null || b === null) {
            return a === b ? left.id.localeCompare(right.id) : a === null ? 1 : -1;
        }
        const compared = typeof a === 'number' && typeof b === 'number' ? a < b ? -1 : a > b ? 1 : 0 : String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'});
        return (sort.descending ? -compared : compared) || left.id.localeCompare(right.id);
    });
}

export function roomListJson(store: LocalStore, entries: RoomListEntry[], sort: ListSort): RoomListJson {
    const byId = new Map(entries.map((entry) => [entry.room.roomId, entry]));
    return {count: entries.length, rooms: sortListRows(roomRows(entries), sort).map((row) => {
        const entry = byId.get(row.id)!;
        const sessions = new Map(sessionRows(store, entry).map((session) => [session.id, session]));
        return {...entry.room, name: entry.snapshot?.name ?? entry.room.name, reachable: entry.reachable, error: entry.why ?? null, live: entry.snapshot ?? null, sessions: entry.room.sessions.map((session) => {
            const values = sessions.get(session.sessionId)!.values;
            const model = values['model']!;
            return {...session, displayName: values['name']!, state: values['state']!, receiverState: values['receiver'] === 'Not managed' ? null : values['receiver']!, reportedModel: model.endsWith('*') || ['—', 'Not started', 'Not reported'].includes(model) ? null : model};
        })};
    })};
}

export async function leaveListedSession(store: LocalStore, roomId: string, sessionId: string): Promise<string> {
    const room = store.room(roomId);
    const session = room?.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!room || !session) {
        throw new UsageError('This saved session no longer exists. Refresh the list.');
    }
    const credential = store.credential(roomId, sessionId);
    if (!credential) {
        throw new UsageError('The session credential is unavailable; its room membership cannot be changed.');
    }
    const client = new PairLobbyClient(room.serverUrl);
    try {
        const snapshot = await client.snapshot(roomId, credential);
        const member = snapshot.participants.find((person) => person.participantId === session.participantId);
        if (!member) {
            throw new UsageError('This participant is not in the room snapshot. Refresh the list.');
        }
        const managed = Boolean(receiverConfiguration(store, sessionId));
        if (managed) {
            await stopReceiver(store, sessionId);
        }
        if (!member.left && !member.revoked && snapshot.lifecycle === 'open') {
            try {
                await client.leave(roomId, credential);
            } catch (error) {
                throw new Error(`${managed ? 'Receiver stopped, but ' : ''}Leaving the room was not confirmed: ${error instanceof Error ? error.message : String(error)}. Refresh before retrying.`);
            }
        }
        return snapshot.lifecycle !== 'open' ? `${managed ? 'Receiver stopped. ' : ''}Room is ${snapshot.lifecycle}; saved session retained.` : 'Session left; saved identity retained for rejoining.';
    } finally {
        client.closeLive();
    }
}

export type RoomRemoval = 'deleted' | 'already_gone';

/**
 * Whether this device may delete the room for everyone: it holds the owner credential
 * (the room was created here), or one of its sessions is an active admin of the room.
 * `entry` is the room as the list last loaded it; without a snapshot only ownership is known.
 */
export function administersListedRoom(store: LocalStore, entry: RoomListEntry): boolean {
    if (store.credential(entry.room.roomId, 'controller')) {
        return true;
    }
    return entry.room.sessions.some((session) => entry.snapshot?.participants.some((person) => person.participantId === session.participantId && person.role === 'controller' && !person.left && !person.revoked && !person.muted) && Boolean(store.credential(entry.room.roomId, session.sessionId)));
}

/** The credential that may act on the whole room: the owner's, else an active admin session's. Null when this device has neither. */
async function administratorCredential(store: LocalStore, room: RoomEntry, client: PairLobbyClient): Promise<string | null> {
    const owner = store.credential(room.roomId, 'controller');
    if (owner) {
        return owner;
    }
    for (const session of room.sessions) {
        const credential = store.credential(room.roomId, session.sessionId);
        if (!credential) {
            continue;
        }
        try {
            const snapshot = await client.snapshot(room.roomId, credential);
            if (snapshot.participants.some((person) => person.participantId === session.participantId && person.role === 'controller' && !person.left && !person.revoked && !person.muted)) {
                return credential;
            }
        } catch (error) {
            if (!(error instanceof ProtocolError) || !['unauthorized', 'participant_revoked', 'room_locked'].includes(error.code)) {
                throw error;
            }
        }
    }
    return null;
}

/** Stops this device's receivers for a room that is about to disappear from it. Best effort: a receiver that is already gone is fine. */
async function stopRoomReceivers(store: LocalStore, room: RoomEntry): Promise<void> {
    for (const session of room.sessions) {
        if (receiverConfiguration(store, session.sessionId)) {
            await stopReceiver(store, session.sessionId).catch(() => undefined);
        }
    }
}

/**
 * Deletes a room and its history for everyone, then drops this device's record of it.
 * Owner or admin only. The relay has to answer: when it cannot be reached nothing is
 * removed, because deleting only the local record would leave the room running without
 * its owner.
 */
export async function deleteListedRoom(store: LocalStore, roomId: string): Promise<RoomRemoval> {
    const room = store.room(roomId);
    if (!room) {
        throw new UsageError('This room is no longer saved. Refresh the list.');
    }
    const client = new PairLobbyClient(room.serverUrl);
    let removal: RoomRemoval = 'deleted';
    try {
        const credential = await administratorCredential(store, room, client);
        if (!credential) {
            throw new UsageError('Deleting a room for everyone requires its owner or an admin.');
        }
        await client.delete(roomId, credential);
    } catch (error) {
        if (error instanceof ProtocolError && error.code === 'server_unavailable') {
            throw new UsageError(`could not reach ${room.serverUrl}, so the room was not deleted.\n  Start the server and try again, or drop this device's record of it:\n    pairlobby forget ${room.roomId}`);
        }
        if (!(error instanceof ProtocolError) || (error.code !== 'room_not_found' && error.code !== 'room_expired')) {
            throw error;
        }
        removal = 'already_gone';
    } finally {
        client.closeLive();
    }
    await stopRoomReceivers(store, room);
    store.forgetRoom(roomId);
    return removal;
}

/**
 * Removes a room from this device without deleting it: each local session leaves, its
 * receiver stops, and the saved record and credentials go. The room and everyone else
 * in it are unaffected. Leaving is best effort, so a relay that is gone cannot keep its
 * rooms in the list forever.
 */
export async function forgetListedRoom(store: LocalStore, roomId: string): Promise<void> {
    const room = store.room(roomId);
    if (!room) {
        throw new UsageError('This room is no longer saved. Refresh the list.');
    }
    for (const session of room.sessions) {
        await leaveListedSession(store, roomId, session.sessionId).catch(() => undefined);
    }
    await stopRoomReceivers(store, room);
    store.forgetRoom(roomId);
}

export async function closeListedRoom(store: LocalStore, roomId: string): Promise<void> {
    const room = store.room(roomId);
    if (!room) {
        throw new UsageError('This room is no longer saved. Refresh the list.');
    }
    const owner = store.credential(roomId, 'controller');
    const client = new PairLobbyClient(room.serverUrl);
    try {
        if (owner) {
            if ((await client.snapshot(roomId, owner)).lifecycle !== 'closed') {
                await client.close(roomId, owner);
            }
            return;
        }
        for (const session of room.sessions) {
            const credential = store.credential(roomId, session.sessionId);
            if (!credential) {
                continue;
            }
            try {
                const snapshot = await client.snapshot(roomId, credential);
                if (snapshot.participants.some((person) => person.participantId === session.participantId && person.role === 'controller' && !person.left && !person.revoked && !person.muted)) {
                    if (snapshot.lifecycle !== 'closed') {
                        await client.close(roomId, credential);
                    }
                    return;
                }
            } catch (error) {
                if (!(error instanceof ProtocolError) || !['unauthorized', 'participant_revoked', 'room_locked'].includes(error.code)) {
                    throw error;
                }
            }
        }
        throw new UsageError('Closing the whole room requires owner or admin access.');
    } finally {
        client.closeLive();
    }
}

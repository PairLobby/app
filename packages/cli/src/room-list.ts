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

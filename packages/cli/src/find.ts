import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import type {RoomEntry} from '@pairlobby/client';
import {ProtocolError} from '@pairlobby/protocol';
import type {ParticipantView, RoomSnapshot} from '@pairlobby/protocol';

export type LastMessage = {
    eventId: string;
    sentAt: number;
    senderId: string | null;
    senderName: string;
    text: string;
};

export type FoundRoom = {
    roomId: string;
    name: string;
    serverUrl: string;
    createdAt: number;
    expiresAt: number | null;
    checkedAt: number;
    reachable: boolean;
    status: 'available' | 'closed' | 'expired' | 'deleted' | 'inaccessible' | 'unreachable' | 'unknown';
    active: boolean | null;
    presence: 'not_tracked';
    participantCount: number | null;
    participants: ParticipantView[] | null;
    locked: boolean | null;
    joinPolicy: RoomSnapshot['policy']['joinPolicy'] | null;
    lastMessage: LastMessage | null;
    lastMessageStatus: 'found' | 'none_retained' | 'unavailable';
    error: string | null;
};

export type FindOptions = {
    rooms?: RoomEntry[];
    timeoutMs?: number;
};

export type FindResult = {
    scope: 'device';
    count: number;
    activeCount: number;
    rooms: FoundRoom[];
};

type AuthorizedSnapshot = {
    credential: string;
    snapshot: RoomSnapshot;
};

const ACCESS_ERRORS = new Set(['unauthorized', 'participant_revoked', 'room_locked']);

function errorCode(error: unknown, signal: AbortSignal): string {
    if (signal.aborted) {
        return 'timeout';
    }
    return error instanceof ProtocolError ? error.code : 'check_failed';
}

async function authorizedSnapshot(store: LocalStore, room: RoomEntry, client: PairLobbyClient): Promise<AuthorizedSnapshot> {
    const credentials = [...new Set([
        ...room.sessions.map((session) => store.credential(room.roomId, session.sessionId)),
        store.credential(room.roomId, 'controller')
    ].filter((credential): credential is string => Boolean(credential)))];
    for (const [index, credential] of credentials.entries()) {
        try {
            return {credential, snapshot: await client.snapshot(room.roomId, credential)};
        } catch (error) {
            if (!(error instanceof ProtocolError) || !ACCESS_ERRORS.has(error.code) || index === credentials.length - 1) {
                throw error;
            }
        }
    }
    throw new ProtocolError('unauthorized', 'no saved credential');
}

/** Search backwards through retained history, bounded by the room's deadline and snapshot watermark. */
async function lastMessage(client: PairLobbyClient, credential: string, snapshot: RoomSnapshot): Promise<LastMessage | null> {
    const floor = Math.max(0, snapshot.earliestSeq - 1);
    let end = snapshot.latestSeq;
    while (end > floor) {
        const after = Math.max(floor, end - 200);
        let cursor = after;
        let latest: LastMessage | null = null;
        // Hosted relays may cap pages by count or bytes below our requested limit.
        while (cursor < end) {
            const page = await client.readEvents(snapshot.roomId, credential, cursor, end - cursor);
            for (const event of page.events) {
                if (event.type === 'message' && event.seq <= end) {
                    latest = {
                        eventId: event.eventId,
                        sentAt: event.at,
                        senderId: event.senderId,
                        senderName: snapshot.participants.find((participant) => participant.participantId === event.senderId)?.displayName ?? event.senderId ?? 'system',
                        text: event.payload.text
                    };
                }
            }
            if (!page.hasMore) {
                break;
            }
            const next = page.events.at(-1)?.seq;
            if (next === undefined || next <= cursor) {
                throw new ProtocolError('server_unavailable', 'history pagination did not advance');
            }
            cursor = next;
        }
        if (latest) {
            return latest;
        }
        end = after;
    }
    return null;
}

async function checkRoom(store: LocalStore, room: RoomEntry, timeoutMs: number): Promise<FoundRoom> {
    const signal = AbortSignal.timeout(timeoutMs);
    const client = new PairLobbyClient(room.serverUrl, undefined, signal);
    const result: FoundRoom = {
        roomId: room.roomId,
        name: room.name,
        serverUrl: room.serverUrl,
        createdAt: room.createdAt,
        expiresAt: room.expiresAt,
        checkedAt: Date.now(),
        reachable: false,
        status: 'unknown',
        active: null,
        presence: 'not_tracked',
        participantCount: null,
        participants: null,
        locked: null,
        joinPolicy: null,
        lastMessage: null,
        lastMessageStatus: 'unavailable',
        error: null
    };
    try {
        const {credential, snapshot} = await authorizedSnapshot(store, room, client);
        const participants = snapshot.participants.filter((participant) => !participant.left && !participant.revoked);
        Object.assign(result, {
            name: snapshot.name,
            createdAt: snapshot.createdAt,
            expiresAt: snapshot.expiresAt,
            reachable: true,
            status: snapshot.lifecycle === 'open' ? 'available' : snapshot.lifecycle,
            active: snapshot.lifecycle === 'open' && participants.length > 0,
            participants,
            participantCount: participants.length,
            locked: snapshot.locked ?? false,
            joinPolicy: snapshot.policy.joinPolicy
        });
        result.lastMessage = await lastMessage(client, credential, snapshot);
        result.lastMessageStatus = result.lastMessage ? 'found' : 'none_retained';
    } catch (error) {
        result.error = errorCode(error, signal);
        if (!result.reachable) {
            if (['room_closed', 'room_expired', 'room_deleted', 'room_not_found'].includes(result.error)) {
                result.status = result.error === 'room_closed' ? 'closed' : result.error === 'room_expired' ? 'expired' : 'deleted';
                result.active = false;
            } else if (ACCESS_ERRORS.has(result.error)) {
                result.status = 'inaccessible';
            } else {
                result.status = ['timeout', 'server_unavailable'].includes(result.error) ? 'unreachable' : 'unknown';
            }
        }
    }
    result.checkedAt = Date.now();
    return result;
}

/** Reads only: never joins, marks messages seen, advances cursors, or starts a receiver. */
export async function findRooms(store: LocalStore, {rooms = store.rooms(), timeoutMs = 5000}: FindOptions = {}): Promise<FindResult> {
    const found: FoundRoom[] = [];
    for (let offset = 0; offset < rooms.length; offset += 4) {
        found.push(...await Promise.all(rooms.slice(offset, offset + 4).map((room) => checkRoom(store, room, timeoutMs))));
    }
    found.sort((a, b) => Number(b.active === true) - Number(a.active === true) || (b.lastMessage?.sentAt ?? b.createdAt) - (a.lastMessage?.sentAt ?? a.createdAt));
    return {scope: 'device', count: found.length, activeCount: found.filter((room) => room.active === true).length, rooms: found};
}

function terminalText(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function formatFoundRooms(result: FindResult): string {
    if (result.count === 0) {
        return 'No matching rooms in this device’s registry.';
    }
    const lines = [`${result.count} rooms found; ${result.activeCount} active (open with joined members).`, 'Membership does not confirm live presence or an agent listening.'];
    for (const room of result.rooms) {
        lines.push('', `${terminalText(room.name)} (${room.roomId}) — ${room.status}${room.locked ? ', locked' : ''}`);
        lines.push(`  Server: ${terminalText(room.serverUrl)}`, `  Created: ${new Date(room.createdAt).toISOString()}`);
        lines.push(`  Members: ${room.participants === null ? 'unknown' : room.participants.map((participant) => `${terminalText(participant.displayName)} [${participant.kind}, ${participant.role}] (${participant.participantId})`).join(', ') || 'none'}`);
        if (room.lastMessage) {
            lines.push(`  Last message: ${new Date(room.lastMessage.sentAt).toISOString()} — ${terminalText(room.lastMessage.senderName)}: ${terminalText(room.lastMessage.text).slice(0, 240)}`);
        } else {
            lines.push(`  Last message: ${room.lastMessageStatus === 'none_retained' ? 'none in retained history' : 'unavailable'}`);
        }
        if (room.error) {
            lines.push(`  Check: ${room.error}`);
        }
    }
    return lines.join('\n');
}

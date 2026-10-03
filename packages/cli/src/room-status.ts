import {stripVTControlCharacters} from 'node:util';
import type {RoomSnapshot, TurnQueue} from '@pairlobby/protocol';
import type {PairLobbyClient} from '@pairlobby/client';
import {describeAutoClose, describeCloseReason} from './auto-close.js';
import type {RoomPanelRow} from './room-panel.js';

type RoomStatusClient = Pick<PairLobbyClient, 'snapshot' | 'readEvents' | 'turnQueue'>;
type RoomStatusContext = {client: RoomStatusClient; roomId: string; credential: string};
type MessageSummary = {count: number; lastAt: number | null};
export type RoomStatus = {room: RoomSnapshot; messages: MessageSummary; turns: TurnQueue | null; at: number};

/** Count message events, not sequence numbers (which also include receipts and joins). */
async function countMessages(context: RoomStatusContext, room: RoomSnapshot): Promise<MessageSummary> {
    let cursor = Math.max(0, room.earliestSeq - 1);
    let count = 0;
    let lastAt: number | null = null;
    while (cursor < room.latestSeq) {
        const page = await context.client.readEvents(context.roomId, context.credential, cursor, Math.min(500, room.latestSeq - cursor));
        if (page.earliestSeq > room.earliestSeq) {
            throw new Error('History changed during the count; run /status again.');
        }
        const events = page.events.filter((event) => event.seq > cursor && event.seq <= room.latestSeq);
        for (const event of events) {
            if (event.type === 'message') {
                count += 1;
                lastAt = event.at;
            }
        }
        const next = events.at(-1)?.seq;
        if (next === undefined || next <= cursor) {
            throw new Error('Room history could not be counted completely; run /status again.');
        }
        cursor = next;
    }
    return {count, lastAt};
}

/** Read-only: does not acknowledge messages, change the chat cursor, or post to the room. */
export async function loadRoomStatus(context: RoomStatusContext): Promise<RoomStatus> {
    const room = await context.client.snapshot(context.roomId, context.credential);
    const [messages, turns] = await Promise.all([
        countMessages(context, room),
        room.groupTurnsSupported ? context.client.turnQueue(context.roomId, context.credential) : Promise.resolve(null)
    ]);
    return {room, messages, turns, at: Date.now()};
}

export function roomStatusRows(status: RoomStatus): RoomPanelRow[] {
    const {room, messages, turns, at} = status;
    const joined = room.participants.filter((person) => !person.left && !person.revoked);
    const agents = joined.filter((person) => person.kind === 'agent' && person.role !== 'guest');
    const agentIds = new Set(agents.map((person) => person.participantId));
    const entries = turns?.entries.filter((entry) => agentIds.has(entry.participantId)) ?? [];
    const working = new Set(entries.filter((entry) => entry.state === 'answering' && entry.workingAt !== undefined && (entry.expiresAt ?? 0) > at).map((entry) => entry.participantId)).size;
    const waiting = new Set(entries.filter((entry) => entry.state === 'waiting').map((entry) => entry.participantId)).size;
    const stalled = new Set(entries.filter((entry) => entry.state === 'stalled').map((entry) => entry.participantId)).size;
    const cleanName = stripVTControlCharacters(room.name).replace(/[\x00-\x1f\x7f]/g, ' ');
    return [
        {id: 'name', section: 'Room', label: 'Name', value: cleanName},
        {id: 'room-id', section: 'Room', label: 'Room ID', value: room.roomId},
        {id: 'state', section: 'Room', label: 'State', value: room.lifecycle},
        {id: 'privacy', section: 'Room', label: 'Guest access', value: room.policy.joinPolicy === 'invite_only' ? 'Invite only' : 'Anyone with room ID (read only)'},
        {id: 'invites', section: 'Room', label: 'Invitations', value: room.policy.inviteRole === 'guest' ? 'Read-only observers' : 'Members who can speak'},
        {id: 'lock', section: 'Room', label: 'Admission lock', value: room.locked ? 'Locked' : 'Unlocked'},
        {id: 'auto-close', section: 'Room', label: 'Auto-close', value: room.autoCloseSupported ? describeAutoClose(room.policy.autoClose) : 'Unavailable on this relay'},
        ...(room.policy.autoClose?.mode === 'agents_and_guests_left' ? [{id: 'auto-close-armed', section: 'Room', label: 'Auto-close armed', value: room.autoCloseArmed ? 'Yes — an agent or guest has joined' : 'No — waiting for an agent or guest to join'}] : []),
        ...(room.closeReason ? [{id: 'close-reason', section: 'Room', label: 'Closed because', value: describeCloseReason(room.closeReason)}] : []),
        {id: 'mode', section: 'Room', label: 'Reply mode', value: turns?.mode ?? 'Unavailable on this relay'},
        {id: 'messages', section: 'Messages', label: 'Messages (retained)', value: String(messages.count), hint: room.earliestSeq > 1 ? 'Older history was removed; this is the retained count.' : 'Message events only; joins and receipts are not counted.'},
        {id: 'joined', section: 'Members', label: 'Joined', value: String(joined.length), hint: 'Membership count, not verified online presence.'},
        {id: 'agents', section: 'Members', label: 'Agents', value: String(agents.length)},
        {id: 'humans', section: 'Members', label: 'Humans', value: String(joined.filter((person) => person.kind === 'human' && person.role !== 'guest').length)},
        {id: 'observers', section: 'Members', label: 'Observers', value: String(joined.filter((person) => person.role === 'guest').length)},
        {id: 'admins', section: 'Members', label: 'Admins', value: String(joined.filter((person) => person.role === 'controller').length), hint: 'Delegated admin memberships; the separate owner credential is not a participant.'},
        {id: 'working', section: 'Activity', label: 'Working agents', value: turns ? String(working) : 'Unavailable'},
        {id: 'waiting', section: 'Activity', label: 'Waiting agents', value: turns ? String(waiting) : 'Unavailable'},
        {id: 'stalled', section: 'Activity', label: 'Stalled agents', value: turns ? String(stalled) : 'Unavailable'},
        {id: 'failed', section: 'Activity', label: 'Failed requests', value: turns ? String(entries.filter((entry) => entry.state === 'failed').length) : 'Unavailable'},
        {id: 'paused', section: 'Activity', label: 'Paused members', value: String(joined.filter((person) => person.paused).length)},
        {id: 'interrupted', section: 'Activity', label: 'Interrupted agents (held)', value: String(joined.filter((person) => person.paused && person.interruptRequested).length), hint: 'Resume them with /resume <name>; their queued work waits until then.'},
        {id: 'muted', section: 'Activity', label: 'Muted members', value: String(joined.filter((person) => person.muted).length)},
        {id: 'created', section: 'Dates', label: 'Created (UTC)', value: new Date(room.createdAt).toISOString()},
        {id: 'expiry', section: 'Dates', label: 'Expires (UTC)', value: room.expiresAt === null ? 'Never' : new Date(room.expiresAt).toISOString()},
        {id: 'auto-close-at', section: 'Dates', label: 'Auto-closes (UTC)', value: room.autoCloseAt ? new Date(room.autoCloseAt).toISOString() : room.lifecycle === 'open' ? 'Not scheduled' : 'Not applicable'},
        {id: 'latest', section: 'Dates', label: 'Last message (UTC)', value: messages.lastAt === null ? 'None retained' : new Date(messages.lastAt).toISOString()},
        {id: 'snapshot', section: 'Dates', label: 'Snapshot (UTC)', value: new Date(at).toISOString()}
    ];
}

export function formatRoomStatus(status: RoomStatus): string {
    const lines: string[] = [];
    let section = '';
    for (const row of roomStatusRows(status)) {
        if (row.section !== section) {
            section = row.section;
            lines.push(`\n${section.toUpperCase()}`);
        }
        lines.push(`  ${row.label.padEnd(22)} : ${row.value}`);
    }
    return lines.join('\n').trimStart();
}

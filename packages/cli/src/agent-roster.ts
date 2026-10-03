import {stripVTControlCharacters} from 'node:util';
import type {LocalStore, PairLobbyClient} from '@pairlobby/client';
import type {RoomSnapshot, TurnQueue} from '@pairlobby/protocol';
import {select, UsageError} from './context.js';
import {receiverConfiguration, receiverStatus} from './receiver.js';
import type {ReceiverStatus} from './receiver.js';
import {readSpawnMetadata} from './spawn-agent.js';
import {modelId, savedSessionModel} from './model-metadata.js';

export type AgentColumn = 'name' | 'provider' | 'status' | 'model' | 'conversationId' | 'invite' | 'origin' | 'lastMessage';
export type AgentRow = {participantId: string; name: string; provider: string; status: string; model: string; configuredModel: boolean; conversationId: string; invite: string; origin: string; lastMessage: string};
export type AgentRoster = {rows: AgentRow[]; at: number; notes: string[]};
export type AgentRosterContext = {store: LocalStore; roomId: string; sessionId: string};
type AgentColumnDefinition = {key: AgentColumn; label: string; width: number};
export const AGENT_COLUMNS: AgentColumnDefinition[] = [
    {key: 'name', label: 'Name', width: 20},
    {key: 'provider', label: 'Provider', width: 12},
    {key: 'status', label: 'Status', width: 19},
    {key: 'model', label: 'Model', width: 28},
    {key: 'conversationId', label: 'Conversation ID', width: 38},
    {key: 'invite', label: 'Invite', width: 14},
    {key: 'origin', label: 'Origin', width: 18},
    {key: 'lastMessage', label: 'Last message date', width: 24}
];

export function plainCell(value: string): string {
    return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, ' ');
}

export function agentProvider(runtime?: string): string {
    const normalized = runtime?.toLowerCase().replace(/-(cli|code)$/u, '');
    if (['codex', 'chatgpt', 'openai'].includes(normalized ?? '')) {
        return 'OpenAI';
    }
    if (normalized === 'claude') {
        return 'Anthropic';
    }
    return normalized === 'qwen' ? 'Qwen' : normalized === 'deepseek' ? 'DeepSeek' : runtime || 'Unknown';
}

function statusFor(participant: RoomSnapshot['participants'][number], receiver: ReceiverStatus | null, queue?: TurnQueue): string {
    if (participant.role === 'guest') {
        return 'Observer';
    }
    if (participant.muted) {
        return 'Muted';
    }
    if (participant.paused && participant.interruptRequested) {
        // Interrupted agents stay held until resumed; say whether the receiver has reported back.
        return (participant.acknowledgedRevision ?? 0) >= participant.controlRevision ? 'Interrupted · held' : 'Interrupt requested';
    }
    if (participant.paused) {
        return 'Paused';
    }
    if (receiver && ['stopped', 'offline', 'error'].includes(receiver.state)) {
        return receiver.state === 'stopped' ? 'Stopped' : receiver.state === 'offline' ? 'Offline' : 'Error';
    }
    const turns = queue?.entries.filter((entry) => entry.participantId === participant.participantId) ?? [];
    if (turns.some((entry) => entry.state === 'answering' && entry.workingAt !== undefined && (entry.expiresAt ?? 0) > Date.now())) {
        return 'Working';
    }
    if (turns.some((entry) => entry.state === 'answering')) {
        return 'Turn claimed';
    }
    if (turns.some((entry) => entry.state === 'stalled')) {
        return 'Stalled';
    }
    if (receiver) {
        const labels: Record<string, string> = {available: 'Ready', working: 'Turn claimed', waiting: 'Waiting', starting: 'Starting', reconnecting: 'Reconnecting', stopped: 'Stopped', offline: 'Offline', error: 'Error', stalled: 'Stalled', paused: 'Paused'};
        return labels[receiver.state] ?? receiver.state;
    }
    return turns.some((entry) => entry.state === 'waiting') ? 'Waiting' : 'Joined (unverified)';
}

/** Raw history reads do not acknowledge messages, advance session cursors, or start inference. */
async function messageDates(client: PairLobbyClient, credential: string, snapshot: RoomSnapshot, ids: Set<string>): Promise<Map<string, number>> {
    const dates = new Map<string, number>();
    const sequences = new Map<string, number>();
    const floor = Math.max(0, snapshot.earliestSeq - 1);
    let end = snapshot.latestSeq;
    while (end > floor && dates.size < ids.size) {
        const after = Math.max(floor, end - 200);
        let cursor = after;
        while (cursor < end) {
            const page = await client.readEvents(snapshot.roomId, credential, cursor, end - cursor);
            for (const event of page.events) {
                if (event.type === 'message' && event.senderId && ids.has(event.senderId) && event.seq <= snapshot.latestSeq && event.seq > (sequences.get(event.senderId) ?? 0)) {
                    sequences.set(event.senderId, event.seq);
                    dates.set(event.senderId, event.at);
                }
            }
            const next = page.events.at(-1)?.seq;
            if (!page.hasMore) {
                break;
            }
            if (next === undefined || next <= cursor) {
                throw new Error('History pagination did not advance');
            }
            cursor = next;
        }
        end = after;
    }
    return dates;
}

export async function loadAgentRoster(context: AgentRosterContext): Promise<AgentRoster> {
    const {store, roomId, sessionId} = context;
    const {room, session, client, credential} = select(store, roomId, sessionId);
    try {
        const snapshot = await client.snapshot(roomId, credential);
        const actor = snapshot.participants.find((participant) => participant.participantId === session.participantId);
        if (!actor || actor.kind !== 'human' || actor.role === 'guest' || actor.left || actor.revoked) {
            throw new UsageError('The agent table requires an active human member.');
        }
        const participants = snapshot.participants.filter((participant) => participant.kind === 'agent' && !participant.left && !participant.revoked);
        const notes = ['Model = exact runtime ID (last reported or recovered from its saved session); * = configured only.', 'Joined is not verified presence. Dates: latest retained message, UTC. Remote metadata is not shared.'];
        let queue: TurnQueue | undefined;
        let dates = new Map<string, number>();
        let historyAvailable = true;
        await Promise.all([
            snapshot.groupTurnsSupported ? client.turnQueue(roomId, credential).then((value) => { queue = value; }).catch(() => { notes.push('Turn status unavailable.'); }) : Promise.resolve(),
            messageDates(client, credential, snapshot, new Set(participants.map((participant) => participant.participantId))).then((value) => { dates = value; }).catch(() => { historyAvailable = false; notes.push('Last message dates unavailable.'); })
        ]);
        let spawns: ReturnType<typeof readSpawnMetadata> = new Map();
        try {
            spawns = readSpawnMetadata(store, roomId);
        } catch {
            notes.push('Local spawn metadata unavailable.');
        }
        const rows = participants.map((participant): AgentRow => {
            const local = room.sessions.find((entry) => entry.participantId === participant.participantId);
            const spawn = local ? spawns.get(local.sessionId) : undefined;
            const receiver = local ? receiverStatus(store, local.sessionId) : null;
            const config = local ? receiverConfiguration(store, local.sessionId) : null;
            const creator = local?.spawnedBy ?? spawn?.actorSessionId;
            const managed = Boolean(config || spawn || local?.spawnedBy);
            const runtime = config?.runtime ?? local?.runtime ?? participant.capabilities?.runtime;
            const threadId = receiver?.threadId || (!managed || receiver?.state === 'stopped' ? local?.conversationId : undefined);
            const reported = modelId(receiver?.model) ?? (local && runtime && threadId ? savedSessionModel({runtime, threadId, cwd: config?.cwd ?? local.cwd}) : undefined);
            const configured = config?.model ?? local?.model ?? spawn?.model;
            const conversationId = threadId || (managed ? 'Not started' : local ? 'Unknown' : 'Not shared');
            const invite = actor.muted ? 'Hidden' : local ? store.sessionInvite(roomId, local.sessionId) ?? spawn?.invite ?? 'Not recorded' : 'Not shared';
            return {
                participantId: participant.participantId, name: plainCell(participant.displayName), provider: plainCell(agentProvider(participant.capabilities?.runtime ?? local?.runtime)),
                status: plainCell(statusFor(participant, receiver, queue)), model: plainCell(reported || configured || (managed && !threadId ? 'Not started' : local ? 'Not reported' : 'Not shared')),
                configuredModel: !reported && Boolean(configured), conversationId: plainCell(conversationId), invite: plainCell(invite),
                origin: creator === sessionId ? 'This session' : creator ? 'Other session' : 'Joined externally',
                lastMessage: dates.has(participant.participantId) ? new Date(dates.get(participant.participantId)!).toISOString() : historyAvailable ? 'None retained' : 'Unavailable'
            };
        });
        return {rows, at: Date.now(), notes};
    } finally {
        client.closeLive();
    }
}

export function formatAgentRoster(roster: AgentRoster): string {
    if (!roster.rows.length) {
        return 'No agents currently in this room.';
    }
    const data = [AGENT_COLUMNS.map((column) => column.label), ...roster.rows.map((row) => AGENT_COLUMNS.map((column) => row[column.key] + (column.key === 'model' && row.configuredModel ? '*' : '')))];
    const widths = AGENT_COLUMNS.map((_, index) => Math.max(...data.map((row) => row[index]!.length)));
    return [data[0]!.map((value, index) => value.padEnd(widths[index]!)).join(' | '), widths.map((width) => '-'.repeat(width)).join('-+-'), ...data.slice(1).map((row) => row.map((value, index) => value.padEnd(widths[index]!)).join(' | ')), ...roster.notes].join('\n');
}

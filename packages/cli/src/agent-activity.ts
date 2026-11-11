import type {MessageRequest, RoomEvent, RoomSnapshot, TurnQueue} from '@pairlobby/protocol';
import {stripVTControlCharacters} from 'node:util';

export type AgentActivityState = 'idle' | 'unread' | 'clear' | 'failed' | 'working' | 'preparing' | 'provider_wait' | 'waiting' | 'stalled' | 'paused' | 'muted' | 'offline' | 'unknown';
export type AgentActivity = {participantId: string; name: string; state: AgentActivityState};
export type AgentActivityContext = {participants: RoomSnapshot['participants']; requests: MessageRequest[]; queue: TurnQueue | null; complete: boolean; available: boolean; offline?: Set<string>};
type ActivityEvidence = {latestMessage: RoomEvent | undefined; acknowledged: Set<string>; settled?: Set<string>; now?: number};
export type ActivityFocus = AgentActivityState | 'turns' | 'all';
type ActivityGroup = {state: AgentActivityState; label: string; agents: AgentActivity[]};

const DESCRIPTIONS: Record<AgentActivityState, string> = {idle: 'Idle · explicitly no further action', clear: 'No queued room task · reading not implied', failed: 'Failed task needs attention', unread: 'Latest transport receipt unconfirmed', working: 'Working', preparing: 'Preparing an answer', provider_wait: 'Provider usage limited · waiting to retry', waiting: 'Waiting · pending request', stalled: 'Stalled request', paused: 'Paused', muted: 'Muted', offline: 'Offline · its receiver on this device is not running; sending a message starts it', unknown: 'Status unavailable'};
const ACTIVITY_ORDER: AgentActivityState[] = ['working', 'preparing', 'provider_wait', 'waiting', 'stalled', 'failed', 'unread', 'idle', 'clear', 'paused', 'muted', 'offline', 'unknown'];

function activityGroups(agents: AgentActivity[]): ActivityGroup[] {
    return ACTIVITY_ORDER.flatMap((state) => {
        const members = agents.filter((agent) => agent.state === state);
        const label = state === 'clear' ? 'no queued task' : state === 'unread' ? 'receipt unconfirmed' : state === 'provider_wait' ? 'provider limited' : state;
        return members.length ? [{state, label: `${members.length} ${label}`, agents: members}] : [];
    });
}

function displayName(agent: AgentActivity, agents: AgentActivity[]): string {
    const name = stripVTControlCharacters(agent.name).replace(/[\x00-\x1f\x7f]/g, ' ');
    return agents.some((other) => other.participantId !== agent.participantId && other.name === agent.name) ? `${name} (${agent.participantId.slice(-6)})` : name;
}

/** The hovered footer count identifies exactly the agents contributing to it. */
export function activityFocusAt(agents: AgentActivity[], mode: TurnQueue['mode'] | undefined, column: number, measure: (text: string) => number): ActivityFocus {
    const prefix = mode ? `Turns: ${mode} | ` : '';
    if (mode && column < measure(prefix)) {
        return 'turns';
    }
    if (agents.length && agents.every((agent) => agent.state === 'idle')) {
        return 'idle';
    }
    let offset = measure(prefix + 'Agents: ');
    for (const group of activityGroups(agents)) {
        const end = offset + measure(group.label);
        if (column >= offset && column < end) {
            return group.state;
        }
        offset = end + measure(' · ');
    }
    return 'all';
}

export function activityDetails(agents: AgentActivity[], focus: ActivityFocus, queue: TurnQueue | null, names: Map<string, string>, now = Date.now()): string[] {
    if (focus === 'turns') {
        if (!queue) {
            return ['Turns', 'The turn queue is unavailable.'];
        }
        const members: AgentActivity[] = queue.entries.map((entry) => ({participantId: entry.participantId, name: names.get(entry.participantId) ?? entry.name, state: entry.state === 'answering' ? (entry.expiresAt ?? 0) <= now ? 'stalled' : entry.workingAt === undefined ? 'preparing' : 'working' : entry.state === 'unavailable' ? 'unknown' : entry.state}));
        return [`Turns · ${queue.mode}`, ...(members.length ? members.map((agent) => `${displayName(agent, members)} — ${DESCRIPTIONS[agent.state]}`) : ['Ready · no queued turns.'])];
    }
    const shown = focus === 'all' ? agents : agents.filter((agent) => agent.state === focus);
    return [focus === 'all' ? 'Agent activity' : `Agents · ${DESCRIPTIONS[focus].split(' · ')[0]}`, ...(shown.length ? shown.map((agent) => `${displayName(agent, agents)} — ${DESCRIPTIONS[agent.state]}`) : ['No agents in this state.'])];
}

/** Transport receipts cannot establish model reading or a deliberate idle decision. */
export function agentActivities(context: AgentActivityContext, evidence: ActivityEvidence): AgentActivity[] {
    const now = evidence.now ?? Date.now();
    return context.participants.filter((person) => person.kind === 'agent' && person.role !== 'guest' && !person.left && !person.revoked).map((person) => {
        const entries = context.queue?.entries.filter((entry) => entry.participantId === person.participantId && entry.state !== 'failed') ?? [];
        const pending = context.requests.some((request) => request.to === person.participantId && request.requiresReply && !request.responseEventId && !request.failureAt && !['answered', 'passed', 'skipped', 'cancelled', 'failed'].includes(request.turnStatus ?? ''));
        let state: AgentActivityState;
        if (!context.available || !context.complete) {
            state = 'unknown';
        } else if (entries.some((entry) => entry.state === 'answering' && entry.workingAt !== undefined && (entry.expiresAt ?? 0) > now)) {
            state = 'working';
        } else if (context.offline?.has(person.participantId)) {
            state = 'offline';
        } else if (person.paused) {
            state = 'paused';
        } else if (person.muted) {
            state = 'muted';
        } else if (entries.some((entry) => entry.state === 'stalled' || (entry.state === 'answering' && (entry.expiresAt ?? 0) <= now))) {
            state = 'stalled';
        } else if (entries.some((entry) => entry.state === 'answering')) {
            state = 'preparing';
        } else if (entries.some((entry) => entry.state === 'provider_wait')) {
            state = 'provider_wait';
        } else if (pending || entries.some((entry) => entry.state === 'waiting')) {
            state = 'waiting';
        } else if (context.requests.some((request) => request.to === person.participantId && request.failureAt && !request.responseEventId && request.requiresReply)) {
            state = 'failed';
        } else if (entries.some((entry) => entry.state === 'unavailable')) {
            state = 'unknown';
        } else if (evidence.latestMessage && evidence.latestMessage.senderId !== person.participantId && !evidence.acknowledged.has(person.participantId)) {
            state = 'unread';
        } else if (evidence.settled?.has(person.participantId)) {
            state = 'idle';
        } else {
            state = 'clear';
        }
        return {participantId: person.participantId, name: person.displayName, state};
    });
}

export function activitySummary(agents: AgentActivity[]): string {
    if (!agents.length) {
        return 'No agents in the room';
    }
    if (agents.every((agent) => agent.state === 'idle')) {
        return `All agents idle (${agents.length}) · no further action declared`;
    }
    return 'Agents: ' + activityGroups(agents).map((group) => group.label).join(' · ');
}

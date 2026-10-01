import type {MessageRequest, RoomEvent, RoomSnapshot, TurnQueue} from '@pairlobby/protocol';

export type AgentActivityState = 'idle' | 'unread' | 'clear' | 'failed' | 'working' | 'preparing' | 'waiting' | 'stalled' | 'paused' | 'muted' | 'unknown';
export type AgentActivity = {participantId: string; name: string; state: AgentActivityState};
export type AgentActivityContext = {participants: RoomSnapshot['participants']; requests: MessageRequest[]; queue: TurnQueue | null; complete: boolean; available: boolean};
type ActivityEvidence = {latestMessage: RoomEvent | undefined; acknowledged: Set<string>; settled?: Set<string>; now?: number};

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
        } else if (person.paused) {
            state = 'paused';
        } else if (person.muted) {
            state = 'muted';
        } else if (entries.some((entry) => entry.state === 'stalled' || (entry.state === 'answering' && (entry.expiresAt ?? 0) <= now))) {
            state = 'stalled';
        } else if (entries.some((entry) => entry.state === 'answering')) {
            state = 'preparing';
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
    const states: AgentActivityState[] = ['working', 'preparing', 'waiting', 'stalled', 'failed', 'unread', 'idle', 'clear', 'paused', 'muted', 'unknown'];
    return 'Agents: ' + states.flatMap((state) => {
        const count = agents.filter((agent) => agent.state === state).length;
        return count ? [`${count} ${state === 'clear' ? 'no queued task' : state === 'unread' ? 'receipt unconfirmed' : state}`] : [];
    }).join(' · ');
}

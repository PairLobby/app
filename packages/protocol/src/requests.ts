/** Durable obligation per addressed message. Transport receipt is not a reply. */
export interface MessageRequest {
    roomId: string;
    eventId: string;
    seq: number;
    from: string;
    to: string;
    text: string;
    at: number;
    requiresReply: boolean;
    receivedAt: number | null;
    readAt?: number;
    action?: 'working' | 'waiting' | 'no_action' | 'declined' | 'reply_pending' | 'done';
    actionAt?: number;
    actionReason?: string;
    responseEventId: string | null;
    respondedAt: number | null;
    progressAt: number | null;
    failureAt?: number | null;
    failureReason?: string | null;
    failureStage?: 'delivery' | 'execution' | 'publishing';
    /** Group messages have one durable delivery ID per recipient. */
    conversationId?: string;
    workingAt?: number;
    turnRequired?: boolean;
    turnRevision?: number;
    turnClaimId?: string;
    turnToken?: string;
    turnExpiresAt?: number;
    turnStatus?: 'running' | 'answered' | 'passed' | 'skipped' | 'cancelled' | 'failed';
    responseText?: string;
}
export type TurnMode = 'sequential' | 'parallel';
export type TurnEntry = {requestId: string; conversationId: string; participantId: string; name: string; state: 'waiting' | 'answering' | 'stalled' | 'paused' | 'unavailable' | 'failed'; expiresAt: number | null; workingAt?: number; runtime?: string};
export type TurnQueue = {mode: TurnMode; entries: TurnEntry[]};
export type TurnGrant = {state: 'granted' | 'waiting' | 'finished' | 'stalled'; token?: string; expiresAt?: number; request?: MessageRequest};
export type TurnAction = {action: 'skip' | 'cancel'; requestId?: string | undefined; participantId?: string | undefined};
export const TURN_LEASE_MS = 90_000;
export type RequestState = 'awaiting_ack' | 'awaiting_reply' | 'ack_overdue' | 'reply_overdue' | 'answered' | 'no_action' | 'declined' | 'failed' | 'waiting_turn' | 'answering' | 'stalled' | 'passed' | 'skipped' | 'cancelled';
export const ACK_TIMEOUT_MS = 30_000;
export const REPLY_TIMEOUT_MS = 5 * 60_000;
export function requestState(request: MessageRequest, now = Date.now()): RequestState {
    if (request.responseEventId) {
        return 'answered';
    }
    if (request.action === 'no_action' || request.action === 'declined') {
        return request.action;
    }
    if (request.failureAt) {
        return 'failed';
    }
    if (request.turnStatus === 'passed' || request.turnStatus === 'skipped' || request.turnStatus === 'cancelled') {
        return request.turnStatus;
    }
    if (request.turnRequired) {
        if (request.turnStatus === 'running') {
            return (request.turnExpiresAt ?? 0) <= now ? 'stalled' : 'answering';
        }
        return 'waiting_turn';
    }
    if (request.receivedAt === null) {
        return now - request.at >= ACK_TIMEOUT_MS ? 'ack_overdue' : 'awaiting_ack';
    }
    return now - Math.max(request.receivedAt, request.progressAt ?? 0) >= REPLY_TIMEOUT_MS ? 'reply_overdue' : 'awaiting_reply';
}

export function messageActionLabel(request: MessageRequest): string {
    if (request.responseEventId) {
        return request.failureAt ? 'Done · recovered' : 'Done';
    }
    if (request.action === 'no_action') {
        return 'No action needed';
    }
    if (request.action === 'declined') {
        return 'Declined';
    }
    if (request.failureAt) {
        return `${failureLabel(request.failureStage)} · no automatic retry`;
    }
    if (request.turnStatus === 'cancelled' || request.turnStatus === 'skipped') {
        return 'Cancelled';
    }
    if (request.turnStatus === 'passed') {
        return 'No action needed';
    }
    if (request.turnStatus === 'running' && (request.turnExpiresAt ?? 0) <= Date.now()) {
        return request.action === 'reply_pending' ? 'Answer saved · blocked by expired lease' : 'Status stale · speaking lease expired';
    }
    if (request.action === 'reply_pending') {
        return 'Answer saved · posting pending';
    }
    if (request.action === 'waiting') {
        return `Waiting${request.actionReason ? ` · ${request.actionReason}` : ''}`;
    }
    if (request.progressAt) {
        return 'Replied · continuing';
    }
    if (request.action === 'working' || request.workingAt) {
        return 'Working';
    }
    return 'Queued';
}

export function failureLabel(stage?: MessageRequest['failureStage']): string {
    return stage === 'delivery' ? 'Delivery unconfirmed' : stage === 'execution' ? 'Execution interrupted' : stage === 'publishing' ? 'Answer posting failed' : 'Request failed';
}
export interface RequestPage {
    requests: MessageRequest[];
    hasMore: boolean;
}

export function mergeMessageRequest(previous: MessageRequest | null | undefined, request: MessageRequest): MessageRequest {
    const newerTurn = previous && (previous.turnRevision ?? 0) > (request.turnRevision ?? 0) ? previous : request;
    return {
        ...request,
        ...(previous && (previous.actionAt ?? 0) > (request.actionAt ?? 0) ? {action: previous.action, actionAt: previous.actionAt, actionReason: previous.actionReason, requiresReply: previous.requiresReply} : {}),
        readAt: previous?.readAt ?? request.readAt,
        ...(newerTurn.turnRevision === undefined ? {} : {
            turnRevision: newerTurn.turnRevision,
            workingAt: newerTurn.workingAt,
            turnRequired: newerTurn.turnRequired,
            turnClaimId: newerTurn.turnClaimId,
            turnToken: newerTurn.turnToken,
            turnExpiresAt: newerTurn.turnExpiresAt,
            turnStatus: newerTurn.turnStatus,
            requiresReply: newerTurn.requiresReply
        }),
        receivedAt: previous?.receivedAt ?? request.receivedAt,
        responseEventId: previous?.responseEventId ?? request.responseEventId,
        responseText: previous?.responseText ?? request.responseText,
        respondedAt: previous?.respondedAt ?? request.respondedAt,
        failureAt: previous?.failureAt ?? request.failureAt,
        failureReason: previous?.failureReason ?? request.failureReason,
        failureStage: previous?.failureStage ?? request.failureStage,
        progressAt: Math.max(previous?.progressAt ?? 0, request.progressAt ?? 0) || null
    } as MessageRequest;
}

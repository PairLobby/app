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
    responseEventId: string | null;
    respondedAt: number | null;
    progressAt: number | null;
    failureAt?: number | null;
    failureReason?: string | null;
    /** Group messages have one durable delivery ID per recipient. */
    conversationId?: string;
    turnRequired?: boolean;
    turnRevision?: number;
    turnClaimId?: string;
    turnToken?: string;
    turnExpiresAt?: number;
    turnStatus?: 'running' | 'answered' | 'passed' | 'skipped' | 'cancelled' | 'failed';
    responseText?: string;
}
export type TurnMode = 'sequential' | 'parallel';
export type TurnEntry = {requestId: string; conversationId: string; participantId: string; name: string; state: 'waiting' | 'answering' | 'stalled' | 'paused' | 'unavailable' | 'failed'; expiresAt: number | null};
export type TurnQueue = {mode: TurnMode; entries: TurnEntry[]};
export type TurnGrant = {state: 'granted' | 'waiting' | 'finished' | 'stalled'; token?: string; expiresAt?: number; request?: MessageRequest};
export type TurnAction = {action: 'skip' | 'cancel'; requestId?: string | undefined; participantId?: string | undefined};
export const TURN_LEASE_MS = 90_000;
export type RequestState = 'awaiting_ack' | 'awaiting_reply' | 'ack_overdue' | 'reply_overdue' | 'answered' | 'failed' | 'waiting_turn' | 'answering' | 'stalled' | 'passed' | 'skipped' | 'cancelled';
export const ACK_TIMEOUT_MS = 30_000;
export const REPLY_TIMEOUT_MS = 5 * 60_000;
export function requestState(request: MessageRequest, now = Date.now()): RequestState {
    if (request.responseEventId) {
        return 'answered';
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
export interface RequestPage {
    requests: MessageRequest[];
    hasMore: boolean;
}

export function mergeMessageRequest(previous: MessageRequest | null | undefined, request: MessageRequest): MessageRequest {
    const newerTurn = previous && (previous.turnRevision ?? 0) > (request.turnRevision ?? 0) ? previous : request;
    return {
        ...request,
        ...(newerTurn.turnRevision === undefined ? {} : {
            turnRevision: newerTurn.turnRevision,
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
        progressAt: Math.max(previous?.progressAt ?? 0, request.progressAt ?? 0) || null
    } as MessageRequest;
}

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
}
export type RequestState = 'awaiting_ack' | 'awaiting_reply' | 'ack_overdue' | 'reply_overdue' | 'answered' | 'failed';
export const ACK_TIMEOUT_MS = 30_000;
export const REPLY_TIMEOUT_MS = 5 * 60_000;
export function requestState(request: MessageRequest, now = Date.now()): RequestState {
    if (request.responseEventId) {
        return 'answered';
    }
    if (request.failureAt) {
        return 'failed';
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

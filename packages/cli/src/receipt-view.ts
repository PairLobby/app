import type {MessageRequest, RoomEvent} from '@pairlobby/protocol';

export type ConfirmedReceipt = {participantId: string; acknowledgedAt: number};

/** Only server-confirmed receipts count; presence, replies and local rendering do not. */
export class ReceiptView {
    private receipts = new Map<string, Map<string, number>>();

    observe(event: RoomEvent): void {
        if (event.type === 'message.received' && event.senderId) {
            this.add(event.payload.eventId, event.senderId, event.at);
        }
    }

    observeRequest(request: MessageRequest): void {
        if (request.receivedAt !== null) {
            this.add(request.conversationId ?? request.eventId, request.to, request.receivedAt);
        }
    }

    forMessage(eventId: string): ConfirmedReceipt[] {
        return [...(this.receipts.get(eventId) ?? [])].map(([participantId, acknowledgedAt]) => ({participantId, acknowledgedAt})).sort((a, b) => a.acknowledgedAt - b.acknowledgedAt);
    }

    private add(eventId: string, participantId: string, at: number): void {
        const receipts = this.receipts.get(eventId) ?? new Map<string, number>();
        receipts.set(participantId, Math.min(receipts.get(participantId) ?? at, at));
        this.receipts.set(eventId, receipts);
    }
}

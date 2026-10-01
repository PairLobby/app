import {failureLabel, messageActionLabel} from '@pairlobby/protocol';
import type {MessageRequest, RoomEvent} from '@pairlobby/protocol';

export type ConfirmedReceipt = {participantId: string; acknowledgedAt: number};
export type MessageStage = {readAt?: number; action?: string; actionAt?: number; reason?: string};

/** Only server-confirmed receipts count; presence, replies and local rendering do not. */
export class ReceiptView {
    private receipts = new Map<string, Map<string, number>>();
    private stages = new Map<string, Map<string, MessageStage>>();
    private deliveries = new Map<string, string>();
    private senders = new Map<string, string>();

    observe(event: RoomEvent): void {
        if (event.type === 'message' && event.senderId) {
            this.senders.set(event.eventId, event.senderId);
        }
        if (event.type === 'message.received' && event.senderId) {
            this.add(event.payload.eventId, event.senderId, event.at);
            const labels = {working: 'Working', waiting: 'Waiting', no_action: 'No action needed', declined: 'Declined', reply_pending: 'Answer saved · posting pending', done: 'Done · answer linked'};
            this.stage(event.payload.eventId, event.senderId, {...(event.payload.stage === 'read' ? {readAt: event.at} : {}), ...(event.payload.action ? {action: labels[event.payload.action], actionAt: event.at, reason: event.payload.reason ?? ''} : {})});
            const originalSender = this.senders.get(event.payload.eventId);
            if (event.payload.action === 'done' && event.payload.responseEventId && originalSender) {
                this.stage(event.payload.responseEventId, originalSender, {action: 'No response requested · linked answer', actionAt: event.at});
            }
        } else if (event.type === 'message' && event.replyTo && event.senderId) {
            this.stage(event.replyTo, event.senderId, {action: event.payload.responseStage === 'progress' ? 'Replied · continuing' : 'Done', actionAt: event.at});
        } else if (event.type === 'message.delivery_failed' && event.senderId) {
            this.stage(this.deliveries.get(event.payload.eventId) ?? event.payload.eventId, event.senderId, {action: failureLabel(event.payload.stage), actionAt: event.at, reason: event.payload.reason});
        }
    }

    observeRequest(request: MessageRequest): void {
        const root = request.conversationId ?? request.eventId;
        this.deliveries.set(request.eventId, root);
        if (request.receivedAt !== null) {
            this.add(request.conversationId ?? request.eventId, request.to, request.receivedAt);
        }
        this.stage(root, request.to, {...(request.readAt === undefined ? {} : {readAt: request.readAt}), action: messageActionLabel(request), actionAt: Math.max(request.actionAt ?? 0, request.respondedAt ?? 0, request.failureAt ?? 0, request.progressAt ?? 0, request.workingAt ?? 0, request.at), reason: request.responseEventId ? request.failureReason ? `Previous attempt: ${request.failureReason}` : '' : request.failureReason ?? request.actionReason ?? ''});
    }

    forParticipant(eventId: string, participantId: string): MessageStage {
        return {...this.stages.get(eventId)?.get(participantId)};
    }

    participants(eventId: string): string[] {
        return [...new Set([...this.forMessage(eventId).map((receipt) => receipt.participantId), ...(this.stages.get(eventId)?.keys() ?? [])])];
    }

    private stage(eventId: string, participantId: string, update: MessageStage): void {
        const people = this.stages.get(eventId) ?? new Map<string, MessageStage>();
        const previous = people.get(participantId) ?? {};
        const next = {...previous};
        if (update.readAt !== undefined) {
            next.readAt = Math.min(previous.readAt ?? update.readAt, update.readAt);
        }
        if (update.action && (update.actionAt ?? 0) >= (previous.actionAt ?? 0)) {
            Object.assign(next, {action: update.action, actionAt: update.actionAt, reason: update.reason});
        }
        people.set(participantId, next);
        this.stages.set(eventId, people);
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

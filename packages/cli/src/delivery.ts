import {ACK_TIMEOUT_MS, REPLY_TIMEOUT_MS} from '@pairlobby/protocol';
import type {MessageRequest} from '@pairlobby/protocol';

export interface DeliveryTarget {
    notify(request: MessageRequest, reminder: boolean): Promise<void>;
    fail(request: MessageRequest, reason: string): Promise<void>;
}
/** Retries notification delivery, never the agent's tools or task side effects. */
export class DeliverySupervisor {
    private attempts = new Map<string, {count: number; next: number; progress: number; failed: boolean}>();
    constructor(private target: DeliveryTarget, private allowedSenders: ReadonlySet<string>
    ) {}
    async tick(requests: MessageRequest[], now = Date.now()): Promise<number> {
        const active = new Set(requests.map((request) => request.eventId));
        for (const id of this.attempts.keys())
            if (!active.has(id)) {
                this.attempts.delete(id);
            }
        let next = now + 300_000;
        let inflight = requests.filter((r) => r.receivedAt === null && this.attempts.has(r.eventId) && !this.attempts.get(r.eventId)!.failed).length;
        for (const request of requests) {
            if (request.responseEventId) {
                continue;
            }
            let attempt = this.attempts.get(request.eventId);
            if (attempt?.failed) {
                continue;
            }
            if (!this.allowedSenders.has(request.from)) {
                await this.target.fail(request, 'Sender has not been approved for this runtime channel. Human approval is required; the request remains unanswered.');
                this.attempts.set(request.eventId, {count: 0, next: Infinity, progress: 0, failed: true});
                continue;
            }
            if (!attempt && request.receivedAt === null && inflight >= 3) {
                next = Math.min(next, now + ACK_TIMEOUT_MS);
                continue;
            }
            if (!attempt) {
                attempt = {count: 0, next: now, progress: 0, failed: false};
                this.attempts.set(request.eventId, attempt);
                if (request.receivedAt === null) {
                    inflight++;
                }
            }
            const progress = Math.max(request.receivedAt ?? 0, request.progressAt ?? 0);
            if (progress > attempt.progress) {
                attempt.progress = progress;
                attempt.count = 0;
                attempt.next = progress + REPLY_TIMEOUT_MS;
            }
            if (now < attempt.next) {
                next = Math.min(next, attempt.next);
                continue;
            }
            if (attempt.count >= 3) {
                await this.target.fail(
                    request,
                    request.receivedAt === null ? 'No agent acknowledgement after three channel deliveries. Check whether the channel is enabled and the runtime is available.' : 'The agent acknowledged this request but did not provide a final reply or fresh progress after repeated reminders.'
                );
                attempt.failed = true;
                if (request.receivedAt === null) {
                    inflight--;
                }
                continue;
            }
            try {
                await this.target.notify(request, attempt.count > 0);
            } catch {
                /* Transport success is not acknowledgement; retry the same ID. */
            }
            attempt.count++;
            attempt.next = now + (request.receivedAt === null ? ACK_TIMEOUT_MS : REPLY_TIMEOUT_MS);
            next = Math.min(next, attempt.next);
        }
        return next;
    }
}

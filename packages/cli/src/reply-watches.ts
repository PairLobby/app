import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {z} from 'zod';
import {join} from 'node:path';
import type {MessageRequest} from '@pairlobby/protocol';
import {replyOutcome, retryableReplyError} from './reply-wait.js';
import type {ReplyOutcome} from './reply-wait.js';

const WatchSchema = z.object({
    requestId: z.string().regex(/^ev_[A-Z0-9]+$/),
    senderId: z.string(),
    parentEventId: z.string().nullable().default(null),
    state: z.enum(['waiting', 'ready', 'handled', 'cancelled']),
    createdAt: z.number(),
    updatedAt: z.number(),
    lastError: z.string().nullable(),
    outcome: z.object({requestId: z.string(), state: z.enum(['pending', 'answered', 'passed', 'no_action', 'declined', 'skipped', 'cancelled', 'failed', 'unavailable']), senderId: z.string(), responseEventId: z.string().nullable(), text: z.string().nullable(), reason: z.string().nullable()}).nullable()
});
const RegistrySchema = z.object({version: z.literal(1), watches: z.array(WatchSchema)});
export type ReplyWatch = z.infer<typeof WatchSchema>;
export type ReplyWatchOptions = {
    path: string;
    participantId: string;
    allowed: Set<string>;
    request: (id: string) => Promise<MessageRequest>;
    notify: (outcome: ReplyOutcome, parentEventId: string | null) => Promise<void>;
};

/** Only an active native channel may defer its Stop hook for a saved dependency. */
export function suspendedReplyParents(directory: string): Set<string> {
    const marker = join(directory, 'channel.pid');
    const owner = join(directory, 'owner.lock');
    const path = join(directory, 'reply-watches.json');
    if (!existsSync(marker) || !existsSync(owner) || !existsSync(path)) {
        return new Set();
    }
    const pid = Number(readFileSync(marker, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0 || readFileSync(owner, 'utf8') !== String(pid)) {
        return new Set();
    }
    try {
        process.kill(pid, 0);
    } catch {
        return new Set();
    }
    const registry = RegistrySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return new Set(registry.watches.filter((watch) => (watch.state === 'waiting' || watch.state === 'ready') && !watch.lastError && watch.parentEventId).map((watch) => watch.parentEventId!));
}

/** Owned by the channel's exclusive process lock. No model calls or expiry timers. */
export class ReplyWatches {
    private watches: ReplyWatch[];
    private notified = new Set<string>();
    private stopped = false;

    constructor(private readonly options: ReplyWatchOptions) {
        // A corrupt registry is an explicit startup error; never discard pending work silently.
        this.watches = existsSync(options.path) ? RegistrySchema.parse(JSON.parse(readFileSync(options.path, 'utf8'))).watches : [];
    }

    list(): ReplyWatch[] {
        return structuredClone(this.watches);
    }

    async watch(requestId: string, parentEventId?: string): Promise<ReplyWatch> {
        if (!/^ev_[A-Z0-9]+$/.test(requestId)) {
            throw new Error('A recipient delivery event ID is required.');
        }
        const request = await this.options.request(requestId);
        const outcome = replyOutcome(request, this.options.participantId);
        if (!this.options.allowed.has(outcome.senderId)) {
            throw new Error('The expected reply sender is not in this channel’s approved --allow-from list.');
        }
        if (parentEventId) {
            if (!/^ev_[A-Z0-9]{26}$/.test(parentEventId)) {
                throw new Error('parentEventId must be a recipient delivery event ID.');
            }
            const parent = await this.options.request(parentEventId);
            if (parent.to !== this.options.participantId || !this.options.allowed.has(parent.from) || !parent.requiresReply || parent.responseEventId || parent.failureAt || parent.turnRequired) {
                throw new Error('The parent must be a pending, approved request addressed to this channel without a managed speaking turn.');
            }
        }
        const existing = this.watches.find((watch) => watch.requestId === request.eventId);
        if (existing) {
            if (existing.parentEventId !== (parentEventId ?? null)) {
                throw new Error('This delivery is already bound to a different parent task.');
            }
            return structuredClone(existing);
        }
        if (this.watches.filter((watch) => watch.state === 'waiting' || watch.state === 'ready').length >= 100) {
            throw new Error('There are already 100 active reply watches. Handle or cancel an existing watch first.');
        }
        const watch: ReplyWatch = {requestId: request.eventId, senderId: request.to, parentEventId: parentEventId ?? null, state: outcome.state === 'pending' ? 'waiting' : 'ready', createdAt: Date.now(), updatedAt: Date.now(), lastError: null, outcome: outcome.state === 'pending' ? null : outcome};
        this.watches.push(watch);
        this.save();
        return structuredClone(watch);
    }

    finish(requestId: string, action: 'handled' | 'cancelled'): ReplyWatch {
        const watch = this.watches.find((item) => item.requestId === requestId);
        if (!watch) {
            throw new Error('No reply watch exists for this delivery.');
        }
        if (action === 'handled' && watch.state === 'waiting') {
            throw new Error('The reply has not arrived. Cancel the watch to stop waiting.');
        }
        if (watch.state !== 'handled' && watch.state !== 'cancelled') {
            watch.state = action;
            watch.updatedAt = Date.now();
            this.save();
        }
        return structuredClone(watch);
    }

    stop(): void {
        this.stopped = true;
    }

    async tick(): Promise<void> {
        for (const watch of this.watches) {
            if (this.stopped) {
                return;
            }
            if (watch.state === 'handled' || watch.state === 'cancelled') {
                continue;
            }
            if (!this.options.allowed.has(watch.senderId)) {
                this.error(watch, 'Not listening: sender is no longer approved for this channel.');
                continue;
            }
            if (watch.parentEventId) {
                try {
                    const parent = await this.options.request(watch.parentEventId);
                    if (this.stopped || !['waiting', 'ready'].includes(watch.state)) {
                        continue;
                    }
                    if (parent.responseEventId || parent.failureAt || !parent.requiresReply) {
                        watch.state = 'cancelled';
                        watch.updatedAt = Date.now();
                        this.save();
                        continue;
                    }
                    this.error(watch, null);
                } catch (error) {
                    if (this.stopped || !['waiting', 'ready'].includes(watch.state)) {
                        continue;
                    }
                    this.error(watch, `Not listening: parent task could not be checked: ${error instanceof Error ? error.message : 'relay unavailable'}`);
                    continue;
                }
            }
            if (watch.state === 'waiting') {
                try {
                    const request = await this.options.request(watch.requestId);
                    if (this.stopped || watch.state !== 'waiting') {
                        continue;
                    }
                    const outcome = replyOutcome(request, this.options.participantId);
                    if (outcome.senderId !== watch.senderId) {
                        throw new Error('The reply sender does not match the saved watch.');
                    }
                    this.error(watch, null);
                    if (outcome.state === 'pending') {
                        continue;
                    }
                    watch.outcome = outcome;
                    watch.state = 'ready';
                    watch.updatedAt = Date.now();
                    this.save();
                } catch (error) {
                    if (this.stopped || watch.state !== 'waiting') {
                        continue;
                    }
                    const reason = error instanceof Error ? error.message : 'Reply lookup failed';
                    if (retryableReplyError(error)) {
                        this.error(watch, `Reconnecting: ${reason}`);
                        continue;
                    }
                    this.error(watch, `Not listening: ${reason}`);
                    watch.outcome = {requestId: watch.requestId, senderId: watch.senderId, state: 'unavailable', responseEventId: null, text: null, reason};
                    watch.state = 'ready';
                    this.save();
                }
            }
            if (!this.stopped && watch.state === 'ready' && watch.outcome && !this.notified.has(watch.requestId)) {
                await this.options.notify(watch.outcome, watch.parentEventId);
                this.notified.add(watch.requestId);
                // Persist ready before notifying. Until handled, a restart replays the same stable ID.
            }
        }
    }

    private error(watch: ReplyWatch, message: string | null): void {
        if (watch.lastError !== message) {
            watch.lastError = message;
            watch.updatedAt = Date.now();
            this.save();
        }
    }

    private save(): void {
        const temporary = `${this.options.path}.tmp`;
        writeFileSync(temporary, JSON.stringify({version: 1, watches: this.watches}) + '\n', {mode: 0o600});
        renameSync(temporary, this.options.path);
    }
}

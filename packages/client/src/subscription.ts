import {MAX_EVENT_WAIT_MS, ProtocolError} from '@pairlobby/protocol';
import type {MessageRequest, ReadEventsResponse, ReceiptUpdate, RoomEvent, RoomSnapshot, TurnQueue} from '@pairlobby/protocol';
import {PairLobbyClient} from './client.js';

export type RoomSubscriptionOptions = {snapshot?: RoomSnapshot; pollIntervalMs?: number};
type RequestCache = {revision: number; value: Promise<MessageRequest[]>};
type TurnCache = {revision: string; value: Promise<TurnQueue>};

/** One transport per membership in this process; dispatch, receipts and UI retain independent cursors. */
export class RoomSubscription {
    private snapshotValue: RoomSnapshot | undefined;
    private ready: Promise<void> | undefined;
    private running: Promise<void> | undefined;
    private readonly stopped = new AbortController();
    private readonly waiters = new Set<() => void>();
    private readonly receipts = new Map<string, ReceiptUpdate>();
    private readonly requestsCache = new Map<string, RequestCache>();
    private turnsCache: TurnCache | undefined;
    private events: RoomEvent[] = [];
    private cursor = 0;
    private receiptRevision = 0;
    private stateRevision = 0;
    private generation = 0;
    private problem: unknown;
    private readonly intervalMs: number;

    constructor(readonly client: PairLobbyClient, readonly roomId: string, readonly credential: string, options: RoomSubscriptionOptions = {}) {
        this.snapshotValue = options.snapshot;
        this.intervalMs = options.pollIntervalMs ?? 1000;
    }

    get version(): number {
        return this.generation;
    }

    private start(): Promise<void> {
        if (this.stopped.signal.aborted) {
            return Promise.reject(new ProtocolError('server_unavailable', 'this room subscription has stopped'));
        }
        this.ready ??= (async () => {
            this.snapshotValue ??= await this.client.snapshot(this.roomId, this.credential);
            this.cursor = this.snapshotValue.latestSeq;
            this.stateRevision = this.snapshotValue.stateRevision ?? 0;
            this.running = this.pump();
        })();
        return this.ready;
    }

    async snapshot(): Promise<RoomSnapshot> {
        await this.start();
        this.check();
        return structuredClone(this.snapshotValue!);
    }

    async read(after: number, limit = 200, receiptsAfter = 0): Promise<ReadEventsResponse> {
        await this.start();
        this.check();
        const snapshot = this.snapshotValue!;
        if (after > 0 && after < snapshot.earliestSeq - 1) {
            throw new ProtocolError('cursor_gap', 'history before this cursor is no longer retained', {earliestAvailableSeq: snapshot.earliestSeq});
        }
        const events = this.events.filter((event) => event.seq > after).slice(0, limit);
        const contiguous = events.length > 0 && events.every((event, index) => event.seq === after + index + 1);
        if (after >= snapshot.latestSeq || contiguous) {
            return {
                events: structuredClone(events), earliestSeq: snapshot.earliestSeq, latestSeq: snapshot.latestSeq,
                hasMore: (events.at(-1)?.seq ?? after) < snapshot.latestSeq,
                receipts: [...this.receipts.values()].filter((mark) => mark.revision > receiptsAfter), receiptRevision: this.receiptRevision
            };
        }
        const page = await this.client.readEvents(this.roomId, this.credential, after, limit, snapshot.receiptMode === 'watermark' ? {receiptsAfter} : {});
        this.accept(page);
        return page;
    }

    async requests(recipientId?: string): Promise<MessageRequest[]> {
        await this.start();
        this.check();
        const revision = this.snapshotValue!.requestRevision ?? this.generation;
        const key = recipientId ?? '*';
        let cached = this.requestsCache.get(key);
        if (!cached || cached.revision !== revision) {
            const value = this.client.pendingRequests(this.roomId, this.credential, recipientId);
            cached = {revision, value};
            this.requestsCache.set(key, cached);
            if (this.requestsCache.size > 4) {
                this.requestsCache.delete(this.requestsCache.keys().next().value!);
            }
            void value.catch(() => {
                if (this.requestsCache.get(key)?.value === value) {
                    this.requestsCache.delete(key);
                }
            });
        }
        return structuredClone(await cached.value);
    }

    async turns(): Promise<TurnQueue> {
        await this.start();
        this.check();
        const snapshot = this.snapshotValue!;
        const revision = `${snapshot.requestRevision ?? this.generation}:${snapshot.turnRevision ?? this.generation}:${snapshot.snapshotRevision ?? this.generation}`;
        if (this.turnsCache?.revision !== revision) {
            const value = this.client.turnQueue(this.roomId, this.credential);
            this.turnsCache = {revision, value};
            void value.catch(() => {
                if (this.turnsCache?.value === value) {
                    this.turnsCache = undefined;
                }
            });
        }
        const queue = structuredClone(await this.turnsCache.value);
        const now = Date.now();
        for (const entry of queue.entries) {
            if ((entry.expiresAt !== null && entry.expiresAt <= now && ['answering', 'waiting'].includes(entry.state)) || (entry.stallAt !== undefined && entry.stallAt <= now && entry.state === 'waiting')) {
                entry.state = 'stalled';
                delete entry.workingAt;
            }
        }
        return queue;
    }

    /** Capture version before reading, then wait on that version so a change between reading and waiting is never lost. */
    wait(version: number, timeoutMs = 300_000, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                this.waiters.delete(finish);
                signal?.removeEventListener('abort', finish);
                this.stopped.signal.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            this.waiters.add(finish);
            signal?.addEventListener('abort', finish, {once: true});
            this.stopped.signal.addEventListener('abort', finish, {once: true});
            if (version !== this.generation || signal?.aborted || this.stopped.signal.aborted || this.problem) {
                finish();
            }
        });
    }

    async stop(): Promise<void> {
        this.stopped.abort();
        this.client.closeLive();
        this.wake();
        await this.running;
    }

    private check(): void {
        if (this.problem) {
            throw this.problem;
        }
    }

    private wake(): void {
        this.generation++;
        for (const wake of [...this.waiters]) {
            wake();
        }
    }

    private accept(page: ReadEventsResponse): void {
        const previous = this.snapshotValue!;
        let changed = page.latestSeq > previous.latestSeq || (page.stateRevision !== undefined && page.stateRevision > this.stateRevision);
        const merged = new Map(this.events.map((event) => [event.seq, event]));
        for (const event of page.events) {
            merged.set(event.seq, event);
        }
        let bytes = 0;
        this.events = [...merged.values()].sort((a, b) => b.seq - a.seq).filter((event, index) => {
            bytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
            return index < 500 && bytes <= 1024 * 1024 && event.seq >= Math.max(previous.earliestSeq, page.earliestSeq);
        }).reverse();
        for (const mark of page.receipts ?? []) {
            if (mark.revision > (this.receipts.get(mark.participantId)?.revision ?? 0)) {
                this.receipts.set(mark.participantId, mark);
                changed = true;
            }
        }
        this.receiptRevision = Math.max(this.receiptRevision, page.receiptRevision ?? 0);
        if (page.stateRevision !== undefined && page.stateRevision >= this.stateRevision) {
            this.stateRevision = page.stateRevision;
            this.snapshotValue = {
                ...(page.snapshot ?? previous), latestSeq: page.latestSeq, earliestSeq: page.earliestSeq,
                stateRevision: page.stateRevision,
                ...(page.requestRevision === undefined ? {} : {requestRevision: page.requestRevision}),
                ...(page.snapshotRevision === undefined ? {} : {snapshotRevision: page.snapshotRevision}),
                ...(page.turnRevision === undefined ? {} : {turnRevision: page.turnRevision}),
                ...(page.autoCloseAt === undefined ? {} : {autoCloseAt: page.autoCloseAt}),
                ...(page.lastMessageAt === undefined ? {} : {lastMessageAt: page.lastMessageAt})
            };
        } else {
            this.snapshotValue = {...previous, latestSeq: Math.max(previous.latestSeq, page.latestSeq), earliestSeq: Math.max(previous.earliestSeq, page.earliestSeq)};
        }
        if (changed) {
            this.wake();
        }
    }

    private async pump(): Promise<void> {
        let failures = 0;
        let first = true;
        while (!this.stopped.signal.aborted) {
            try {
                const transport = await this.client.liveTransport();
                const modern = this.snapshotValue!.syncSupported === true;
                if (!first && transport === 'websocket') {
                    const expiry = this.snapshotValue!.expiresAt;
                    const timeout = Math.max(1, Math.min(modern ? 30_000 : 5000, expiry === null ? Infinity : expiry - Date.now()));
                    await this.client.waitForChange(this.roomId, this.credential, this.cursor, timeout, this.intervalMs, modern ? {stateAfter: this.stateRevision} : {});
                    if (this.stopped.signal.aborted) {
                        break;
                    }
                    if (modern && this.client.liveLatestSeq <= this.cursor && this.client.liveStateRevision <= this.stateRevision && (expiry === null || expiry > Date.now())) {
                        this.client.reconcileLive();
                        continue;
                    }
                }
                const expiresAt = this.snapshotValue!.expiresAt;
                const waitMs = transport === 'long-poll' ? Math.max(0, Math.min(MAX_EVENT_WAIT_MS, expiresAt === null ? Infinity : expiresAt - Date.now())) : 0;
                const page = modern
                    ? await this.client.syncEvents(this.roomId, this.credential, {after: this.cursor, stateAfter: this.stateRevision, ...(this.snapshotValue!.snapshotRevision === undefined ? {} : {snapshotAfter: this.snapshotValue!.snapshotRevision}), receiptsAfter: this.receiptRevision, waitMs, signal: this.stopped.signal})
                    : await this.client.readEvents(this.roomId, this.credential, this.cursor);
                if (!modern) {
                    this.snapshotValue = await this.client.snapshot(this.roomId, this.credential);
                    this.requestsCache.clear();
                    this.turnsCache = undefined;
                    this.wake();
                }
                const recovering = this.problem !== undefined;
                this.problem = undefined;
                failures = 0;
                this.accept(page);
                this.cursor = page.events.at(-1)?.seq ?? this.cursor;
                first = page.hasMore;
                if (recovering) {
                    this.wake();
                }
                if (!page.hasMore && transport === 'poll') {
                    await this.delay(this.intervalMs);
                }
            } catch (error) {
                if (this.stopped.signal.aborted) {
                    break;
                }
                if (error instanceof ProtocolError && error.code === 'cursor_gap' && error.details.earliestAvailableSeq !== undefined) {
                    this.cursor = error.details.earliestAvailableSeq - 1;
                    this.events = [];
                    first = true;
                    continue;
                }
                this.problem = error;
                this.client.closeLive();
                this.wake();
                if (error instanceof ProtocolError && ['room_expired', 'room_closed', 'room_not_found', 'participant_revoked', 'unauthorized'].includes(error.code)) {
                    return;
                }
                await this.delay(Math.min(5000, 250 * 2 ** Math.min(failures++, 5)));
                first = true;
            }
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                this.stopped.signal.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            this.stopped.signal.addEventListener('abort', finish, {once: true});
            if (this.stopped.signal.aborted) {
                finish();
            }
        });
    }
}

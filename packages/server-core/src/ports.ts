//! What a relay's platform supplies to the shared kernel (`relay.ts`): how room work is
//! ordered, when the kernel is woken again, and what the transport saw of the caller.
//! Each platform implements these once; no protocol rule lives on that side.

/** What the transport knows about a request and no header can claim. */
export type RequestContext = {
    /** The address of the connection the request arrived on; absent when the platform cannot see it. */
    peerAddress?: string;
};

/**
 * Runs a room's work in order. `write` is false for a request that changes nothing, which may
 * start once the writes queued before it are done but does not hold up the ones after it.
 */
export interface RoomExecutor {
    run<T>(roomId: string | null, write: boolean, action: () => Promise<T>): Promise<T>;
    /** Resolves once every write already queued has finished. */
    idle(): Promise<void>;
}

/** Wakes the kernel's `tick` at a time; `null` cancels the wake-up. A later call replaces an earlier one. */
export interface Scheduler {
    plan(at: number | null): void;
}

/** Runs everything as it comes, for a platform that already orders a room's work, such as a Durable Object. */
export function directExecutor(): RoomExecutor {
    return {
        run: (_roomId, _write, action) => action(),
        idle: () => Promise.resolve()
    };
}

/**
 * One queue for every room, for a relay with one process over one store: two writes never
 * interleave, so two cannot both choose the same next event sequence.
 */
export function queueExecutor(): RoomExecutor {
    let writes: Promise<unknown> = Promise.resolve();
    return {
        run(_roomId, write, action) {
            const result = writes.then(action);
            if (write) {
                writes = result.catch(() => {});
            }
            return result;
        },
        idle: () => writes.then(() => {})
    };
}

type TimerSchedulerOptions = {now?: () => number};

/** A `setTimeout` per wake-up that never keeps the process alive; `stop` cancels it for good. */
export function timerScheduler(wake: () => void, {now = Date.now}: TimerSchedulerOptions = {}): Scheduler & {stop(): void} {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    return {
        plan(at) {
            clearTimeout(timer);
            timer = undefined;
            if (stopped || at === null) {
                return;
            }
            timer = setTimeout(wake, Math.min(Math.max(0, at - now()), 2 ** 31 - 1));
            (timer as {unref?: () => void}).unref?.();
        },
        stop() {
            stopped = true;
            clearTimeout(timer);
        }
    };
}

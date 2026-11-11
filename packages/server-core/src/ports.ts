//! What a relay's platform supplies to the shared kernel (`relay.ts`): how room work is
//! ordered, when the kernel is woken again, and what the transport saw of the caller.
//! Each platform implements these once; no protocol rule lives on that side.

import type {RoomSnapshot} from '@pairlobby/protocol';

export type ConnectionAuthorization = (participantId: string) => Promise<RoomSnapshot>;

/** Transport owns tickets and sockets; the kernel supplies authorization again at upgrade. */
export interface RoomConnections {
    ticket(roomId: string, participantId: string, expiresAt: number, request: Request): Promise<string>;
    connect(roomId: string, request: Request, authorize: ConnectionAuthorization): Promise<Response>;
}

/** What the transport knows about a request and no header can claim. */
export type RequestContext = {
    /** The address of the connection the request arrived on; absent when the platform cannot see it. */
    peerAddress?: string;
};

/**
 * Runs a short room operation in order. `write` identifies an explicit mutation; reads may still
 * enforce a persisted deadline. Never hold this scope while waiting for a notification or a client.
 */
export interface RoomExecutor {
    run<T>(roomId: string | null, write: boolean, action: () => Promise<T>): Promise<T>;
    /** Resolves once every write already queued has finished. */
    idle(): Promise<void>;
}

/** Wakes the kernel's `tick` at a time; `null` cancels the wake-up. A later call replaces an earlier one. */
export interface Scheduler {
    plan(at: number | null): void | Promise<void>;
}

/** Runs everything as it comes, for a platform that already orders a room's work, such as a Durable Object. */
export function directExecutor(): RoomExecutor {
    return {
        run: (_roomId, _write, action) => action(),
        idle: () => Promise.resolve()
    };
}

/**
 * One queue per room. SQLite transactions remain synchronous, while unrelated rooms may overlap
 * their asynchronous reads and hashing. A null key orders owner-wide maintenance independently.
 */
export function queueExecutor(): RoomExecutor {
    const queues = new Map<string | null, Promise<unknown>>();
    return {
        run(roomId, _write, action) {
            const result = (queues.get(roomId) ?? Promise.resolve()).then(action);
            const pending = result.catch(() => {}).finally(() => {
                if (queues.get(roomId) === pending) {
                    queues.delete(roomId);
                }
            });
            queues.set(roomId, pending);
            return result;
        },
        idle: () => Promise.all([...queues.values()]).then(() => {})
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

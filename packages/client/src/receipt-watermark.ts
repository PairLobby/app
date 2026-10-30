//! Sends a participant's receipt watermark at most once per interval, and only when it moved,
//! so a reader going through a busy room costs one small request every few seconds instead of
//! one receipt per message.

export type ReceiptPoster = (throughSeq: number) => Promise<unknown>;

export type ReceiptCoalescerOptions = {
    /** The shortest time between two posts. */
    intervalMs?: number;
    now?: () => number;
    /** A post that failed; the same watermark is tried again at the next interval. */
    onError?: (error: unknown) => void;
};

export class ReceiptCoalescer {
    private target = 0;
    private sent = 0;
    private lastPostAt = Number.NEGATIVE_INFINITY;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private sending: Promise<void> | null = null;
    private stopped = false;
    private readonly intervalMs: number;
    private readonly now: () => number;
    private readonly onError: ((error: unknown) => void) | undefined;

    constructor(private readonly post: ReceiptPoster, {intervalMs = 2000, now = Date.now, onError}: ReceiptCoalescerOptions = {}) {
        this.intervalMs = intervalMs;
        this.now = now;
        this.onError = onError;
    }

    /** What the relay has confirmed so far. */
    get confirmed(): number {
        return this.sent;
    }

    /** Everything up to `throughSeq` arrived: sent now, or once the interval since the last post has passed. */
    advance(throughSeq: number): void {
        if (this.stopped || throughSeq <= this.target) {
            return;
        }
        this.target = throughSeq;
        this.schedule();
    }

    /** Sends what is waiting without waiting for the interval, for a reader about to stop. */
    async flush(): Promise<void> {
        clearTimeout(this.timer);
        this.timer = undefined;
        await this.sending;
        if (this.target > this.sent) {
            await this.send();
        }
    }

    /** Drops anything not yet sent. */
    stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule(): void {
        if (this.timer || this.sending || this.stopped) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.send();
        }, Math.max(0, this.lastPostAt + this.intervalMs - this.now()));
        (this.timer as {unref?: () => void}).unref?.();
    }

    private send(): Promise<void> {
        const through = this.target;
        this.lastPostAt = this.now();
        this.sending = this.post(through).then(
            () => {
                this.sent = Math.max(this.sent, through);
            },
            (error: unknown) => this.onError?.(error)
        ).finally(() => {
            this.sending = null;
            if (this.target > this.sent) {
                this.schedule();
            }
        });
        return this.sending;
    }
}

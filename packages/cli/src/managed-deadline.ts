export const DEFAULT_MANAGED_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MANAGED_ABSOLUTE_TIMEOUT_MS = 60 * 60_000;
export const MIN_MANAGED_TIMEOUT_MS = 1_000;
export const MAX_MANAGED_TIMEOUT_MS = 24 * 60 * 60_000;

export type ManagedDeadlinePolicy = {
    idleMs: number;
    absoluteMs: number;
};

export type ManagedDeadlineSnapshot = {
    startedAt: number;
    lastActivityAt: number;
    idleDeadlineAt: number;
    absoluteDeadlineAt: number;
};

export type ManagedDeadlineKind = 'idle' | 'absolute';
type DeadlineExpired = (kind: ManagedDeadlineKind, snapshot: ManagedDeadlineSnapshot) => void;
type DeadlineActivity = (snapshot: ManagedDeadlineSnapshot) => void;

export class ManagedDeadlineExpired extends Error {
    constructor(readonly runtime: string, readonly kind: ManagedDeadlineKind, readonly policy: ManagedDeadlinePolicy) {
        const reason = kind === 'idle'
            ? `produced no runtime activity for ${durationLabel(policy.idleMs)}`
            : `exceeded the ${durationLabel(policy.absoluteMs)} absolute request limit`;
        super(`${runtime} ${reason}; work was stopped, not retried.`);
        this.name = 'ManagedDeadlineExpired';
    }
}

export const DEFAULT_MANAGED_DEADLINE: ManagedDeadlinePolicy = {
    idleMs: DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
    absoluteMs: DEFAULT_MANAGED_ABSOLUTE_TIMEOUT_MS
};

export function validateManagedDeadline(policy: ManagedDeadlinePolicy): ManagedDeadlinePolicy {
    for (const [label, value] of [['inactivity timeout', policy.idleMs], ['absolute timeout', policy.absoluteMs]] as const) {
        if (!Number.isSafeInteger(value) || value < MIN_MANAGED_TIMEOUT_MS || value > MAX_MANAGED_TIMEOUT_MS) {
            throw new Error(`${label} must be between 1 second and 24 hours`);
        }
    }
    if (policy.absoluteMs < policy.idleMs) {
        throw new Error('absolute timeout must be at least the inactivity timeout');
    }
    return policy;
}

export function managedDeadlinePolicy(policy?: Partial<ManagedDeadlinePolicy>): ManagedDeadlinePolicy {
    return validateManagedDeadline({...DEFAULT_MANAGED_DEADLINE, ...policy});
}

function durationLabel(ms: number): string {
    if (ms % 3_600_000 === 0) {
        const hours = ms / 3_600_000;
        return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    }
    if (ms % 60_000 === 0) {
        const minutes = ms / 60_000;
        return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    }
    const seconds = ms / 1_000;
    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

export function managedDeadlineError(runtime: string, kind: ManagedDeadlineKind, policy: ManagedDeadlinePolicy): Error {
    return new ManagedDeadlineExpired(runtime, kind, policy);
}

/** Two independent bounds: activity extends the idle limit but never the absolute limit. */
export class ManagedDeadline {
    private idleTimer: NodeJS.Timeout | undefined;
    private absoluteTimer: NodeJS.Timeout | undefined;
    private stopped = false;
    private snapshotValue: ManagedDeadlineSnapshot;

    constructor(private readonly policy: ManagedDeadlinePolicy, private readonly expired: DeadlineExpired, private readonly activity?: DeadlineActivity) {
        validateManagedDeadline(policy);
        const now = Date.now();
        this.snapshotValue = {startedAt: now, lastActivityAt: now, idleDeadlineAt: Math.min(now + policy.idleMs, now + policy.absoluteMs), absoluteDeadlineAt: now + policy.absoluteMs};
        this.absoluteTimer = setTimeout(() => this.expire('absolute'), policy.absoluteMs);
        this.scheduleIdle(now);
        this.activity?.(this.snapshot());
    }

    touch(): void {
        if (this.stopped) {
            return;
        }
        const now = Date.now();
        this.snapshotValue = {...this.snapshotValue, lastActivityAt: now, idleDeadlineAt: Math.min(now + this.policy.idleMs, this.snapshotValue.absoluteDeadlineAt)};
        this.scheduleIdle(now);
        this.activity?.(this.snapshot());
    }

    snapshot(): ManagedDeadlineSnapshot {
        return {...this.snapshotValue};
    }

    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        clearTimeout(this.idleTimer);
        clearTimeout(this.absoluteTimer);
    }

    private scheduleIdle(now: number): void {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.expire('idle'), Math.max(0, this.snapshotValue.idleDeadlineAt - now));
    }

    private expire(kind: ManagedDeadlineKind): void {
        if (this.stopped) {
            return;
        }
        const resolvedKind = kind === 'idle' && Date.now() >= this.snapshotValue.absoluteDeadlineAt ? 'absolute' : kind;
        this.stop();
        this.expired(resolvedKind, this.snapshot());
    }
}

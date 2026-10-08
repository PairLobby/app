import {afterEach, expect, test, vi} from 'vitest';
import {ManagedDeadline, managedDeadlineError, validateManagedDeadline} from './managed-deadline.js';

afterEach(() => {
    vi.useRealTimers();
});

test('activity extends the idle deadline without extending the absolute deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const expired = vi.fn();
    const activity = vi.fn();
    const deadline = new ManagedDeadline({idleMs: 1_000, absoluteMs: 2_500}, expired, activity);
    expect(deadline.snapshot()).toEqual({startedAt: 1_000, lastActivityAt: 1_000, idleDeadlineAt: 2_000, absoluteDeadlineAt: 3_500});

    vi.advanceTimersByTime(800);
    deadline.touch();
    expect(deadline.snapshot()).toMatchObject({lastActivityAt: 1_800, idleDeadlineAt: 2_800, absoluteDeadlineAt: 3_500});
    vi.advanceTimersByTime(800);
    deadline.touch();
    expect(deadline.snapshot()).toMatchObject({lastActivityAt: 2_600, idleDeadlineAt: 3_500, absoluteDeadlineAt: 3_500});
    vi.advanceTimersByTime(900);
    expect(expired).toHaveBeenCalledOnce();
    expect(expired).toHaveBeenCalledWith('absolute', expect.objectContaining({absoluteDeadlineAt: 3_500}));
    expect(activity).toHaveBeenCalledTimes(3);
});

test('silence expires the inactivity watchdog and stopping cancels both timers', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const deadline = new ManagedDeadline({idleMs: 1_000, absoluteMs: 5_000}, expired);
    vi.advanceTimersByTime(999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledWith('idle', expect.any(Object));

    const cancelled = vi.fn();
    const stopped = new ManagedDeadline({idleMs: 1_000, absoluteMs: 5_000}, cancelled);
    stopped.stop();
    vi.advanceTimersByTime(5_000);
    expect(cancelled).not.toHaveBeenCalled();
});

test('policy validation and failure messages keep the two limits distinct', () => {
    expect(() => validateManagedDeadline({idleMs: 10_000, absoluteMs: 5_000})).toThrow('at least');
    expect(() => validateManagedDeadline({idleMs: 999, absoluteMs: 5_000})).toThrow('between 1 second');
    expect(managedDeadlineError('Claude', 'idle', {idleMs: 60_000, absoluteMs: 3_600_000}).message).toContain('no runtime activity for 1 minute');
    expect(managedDeadlineError('Claude', 'absolute', {idleMs: 60_000, absoluteMs: 3_600_000}).message).toContain('1 hour absolute');
});

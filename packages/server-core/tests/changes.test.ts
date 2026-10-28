import {describe, expect, test} from 'vitest';

import {ChangeNotifier} from '../src/changes.js';

describe('change notifier', () => {
    test('test_a_change_wakes_only_that_rooms_waiters', async () => {
        const changes = new ChangeNotifier();
        const first = changes.wait('rm_a', 10_000)!;
        const other = changes.wait('rm_b', 50)!;
        changes.changed('rm_a');
        expect(await first.changed).toBe(true);
        expect(await other.changed).toBe(false);
        expect(changes.waiting).toBe(0);
    });

    test('test_cancel_and_close_release_waits_and_the_cap_answers_at_once', async () => {
        const changes = new ChangeNotifier({maxWaiters: 2});
        const cancelled = changes.wait('rm_a', 10_000)!;
        const held = changes.wait('rm_a', 10_000)!;
        expect(changes.wait('rm_a', 10_000)).toBeNull();
        cancelled.cancel();
        expect(await cancelled.changed).toBe(false);
        expect(changes.waiting).toBe(1);
        changes.close();
        expect(await held.changed).toBe(false);
        expect(changes.wait('rm_a', 10_000)).toBeNull();
        expect(changes.waiting).toBe(0);
    });
});

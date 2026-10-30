import {expect, test, vi} from 'vitest';

import {ReceiptCoalescer} from '../src/receipt-watermark.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('test_the_first_watermark_goes_at_once_and_later_ones_wait_out_the_interval_as_one_post', async () => {
    vi.useFakeTimers();
    try {
        const posted: number[] = [];
        const coalescer = new ReceiptCoalescer(async (through) => {
            posted.push(through);
        }, {intervalMs: 2000, now: () => Date.now()});
        coalescer.advance(5);
        await vi.advanceTimersByTimeAsync(0);
        expect(posted).toEqual([5]);
        coalescer.advance(7);
        coalescer.advance(9);
        coalescer.advance(8);
        await vi.advanceTimersByTimeAsync(1999);
        expect(posted).toEqual([5]);
        await vi.advanceTimersByTimeAsync(1);
        expect(posted).toEqual([5, 9]);
        coalescer.advance(9);
        await vi.advanceTimersByTimeAsync(5000);
        expect(posted).toEqual([5, 9]);
        expect(coalescer.confirmed).toBe(9);
    } finally {
        vi.useRealTimers();
    }
});

test('test_a_failed_post_is_tried_again_and_flush_sends_without_waiting', async () => {
    const posted: number[] = [];
    const errors: unknown[] = [];
    let failing = true;
    const coalescer = new ReceiptCoalescer(async (through) => {
        if (failing) {
            throw new Error('relay away');
        }
        posted.push(through);
    }, {intervalMs: 60_000, onError: (error) => errors.push(error)});
    coalescer.advance(3);
    await settle();
    await settle();
    expect(errors).toHaveLength(1);
    expect(coalescer.confirmed).toBe(0);
    failing = false;
    await coalescer.flush();
    expect(posted).toEqual([3]);
    coalescer.stop();
    coalescer.advance(10);
    await coalescer.flush();
    expect(posted).toEqual([3]);
});

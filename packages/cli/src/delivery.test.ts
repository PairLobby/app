import {describe, expect, test} from 'vitest';
import type {MessageRequest} from '@pairlobby/protocol';
import {DeliverySupervisor} from './delivery.js';
const request = (id: string): MessageRequest => ({
    roomId: 'room',
    eventId: id,
    seq: 1,
    from: 'alice',
    to: 'bob',
    text: 'Please answer',
    at: 0,
    requiresReply: true,
    receivedAt: null,
    responseEventId: null,
    respondedAt: null,
    progressAt: null
});
describe('runtime delivery supervision', () => {
    test('transport writes are never treated as acknowledgement, and attempts fail visibly', async () => {
        const notifications: string[] = [];
        const failures: string[] = [];
        const supervisor = new DeliverySupervisor(
            {
                notify: async (r) => {
                    notifications.push(r.eventId);
                },
                fail: async (r) => {
                    failures.push(r.eventId);
                }
            },
            new Set(['alice'])
        );
        const r = request('one');
        for (const now of [0, 30_000, 60_000, 90_000, 120_000]) await supervisor.tick([r], now);
        expect(notifications).toEqual(['one', 'one', 'one']);
        expect(failures).toEqual(['one']);
        expect(r.receivedAt).toBeNull();
        expect(r.responseEventId).toBeNull();
    });
    test('receipt stops delivery retries, but an unanswered request still triggers reply reminders', async () => {
        const notifications: number[] = [];
        let failures = 0;
        const supervisor = new DeliverySupervisor(
            {
                notify: async () => {
                    notifications.push(1);
                },
                fail: async () => {
                    failures++;
                }
            },
            new Set(['alice'])
        );
        const r = request('one');
        await supervisor.tick([r], 0);
        r.receivedAt = 1000;
        await supervisor.tick([r], 30_000);
        expect(notifications).toHaveLength(1);
        for (const now of [301_000, 601_000, 901_000, 1201_000]) await supervisor.tick([r], now);
        expect(failures).toBe(1);
    });
    test('fresh progress extends work time and an answer removes the obligation', async () => {
        let pushes = 0;
        let failures = 0;
        const supervisor = new DeliverySupervisor(
            {
                notify: async () => {
                    pushes++;
                },
                fail: async () => {
                    failures++;
                }
            },
            new Set(['alice'])
        );
        const r = request('one');
        await supervisor.tick([r], 0);
        r.receivedAt = 1000;
        r.progressAt = 290_000;
        await supervisor.tick([r], 301_000);
        expect(pushes).toBe(1);
        await supervisor.tick([], 900_000);
        expect(failures).toBe(0);
    });
    test('unapproved senders are reported as failed without injecting their content', async () => {
        let pushes = 0;
        let failures = 0;
        const supervisor = new DeliverySupervisor(
            {
                notify: async () => {
                    pushes++;
                },
                fail: async () => {
                    failures++;
                }
            },
            new Set()
        );
        await supervisor.tick([request('one')], 0);
        expect(pushes).toBe(0);
        expect(failures).toBe(1);
    });
    test('acknowledgements free notification capacity while previous work continues', async () => {
        const pushes: string[] = [];
        const supervisor = new DeliverySupervisor(
            {
                notify: async (r) => {
                    pushes.push(r.eventId);
                },
                fail: async () => {}
            },
            new Set(['alice'])
        );
        const requests = ['one', 'two', 'three', 'four'].map(request);
        await supervisor.tick(requests, 0);
        expect(pushes).toHaveLength(3);
        requests[0]!.receivedAt = 1000;
        await supervisor.tick(requests, 1000);
        expect(pushes).toEqual(['one', 'two', 'three', 'four']);
    });
});

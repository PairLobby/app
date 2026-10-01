import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test, vi} from 'vitest';
import {ProtocolError, newId} from '@pairlobby/protocol';
import type {MessageRequest} from '@pairlobby/protocol';
import {ReplyWatches} from '../src/reply-watches.js';
import type {ReplyOutcome} from '../src/reply-wait.js';

function request(): MessageRequest {
    return {roomId: newId('room'), eventId: newId('event'), seq: 1, from: newId('participant'), to: newId('participant'), text: 'Review this', at: Date.now(), requiresReply: true, receivedAt: null, responseEventId: null, respondedAt: null, progressAt: null};
}

test('reply subscriptions deduplicate, survive restart, replay until handled, and never wake on ACK/progress', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reply-watches-'));
    const target = request();
    const notices: ReplyOutcome[] = [];
    const options = {path: join(directory, 'watches.json'), participantId: target.from, allowed: new Set([target.to]), request: async () => target, notify: async (outcome: ReplyOutcome) => { notices.push(outcome); }};
    try {
        let book = new ReplyWatches(options);
        await book.watch(target.eventId);
        await book.watch(target.eventId);
        expect(book.list()).toHaveLength(1);
        expect(() => book.finish(target.eventId, 'handled')).toThrow('not arrived');
        target.receivedAt = Date.now();
        target.progressAt = Date.now();
        await book.tick();
        expect(notices).toHaveLength(0);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 26 * 60_000);
        try {
            await book.tick();
            expect(book.list()[0]?.state).toBe('waiting');
            expect(notices).toHaveLength(0);
        } finally {
            clock.mockRestore();
        }
        book.stop();
        // A reply arriving while disconnected is recovered from durable request state.
        target.responseEventId = newId('event');
        target.respondedAt = Date.now();
        target.responseText = 'Verified result';
        book = new ReplyWatches(options);
        await book.tick();
        await book.tick();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({state: 'answered', text: 'Verified result', senderId: target.to});
        book.stop();
        book = new ReplyWatches(options);
        await book.tick();
        expect(notices).toHaveLength(2);
        expect(notices[1]).toEqual(notices[0]);
        book.finish(target.eventId, 'handled');
        book.stop();
        book = new ReplyWatches(options);
        await book.watch(target.eventId);
        await book.tick();
        expect(notices).toHaveLength(2);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test('cancellation and shutdown fence in-flight lookups; unrelated memberships cannot subscribe', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reply-watch-cancel-'));
    const target = request();
    let resolve!: (value: MessageRequest) => void;
    let calls = 0;
    const notices: ReplyOutcome[] = [];
    const options = {path: join(directory, 'watches.json'), participantId: target.from, allowed: new Set([target.to]), request: async () => calls++ === 0 ? target : new Promise<MessageRequest>((done) => { resolve = done; }), notify: async (outcome: ReplyOutcome) => { notices.push(outcome); }};
    try {
        const book = new ReplyWatches(options);
        await book.watch(target.eventId);
        const ticking = book.tick();
        book.finish(target.eventId, 'cancelled');
        resolve({...target, responseEventId: newId('event'), responseText: 'late'});
        await ticking;
        expect(notices).toHaveLength(0);
        expect(book.list()[0]?.state).toBe('cancelled');
        const other = new ReplyWatches({...options, path: join(directory, 'other.json'), participantId: target.to, request: async () => target});
        await expect(other.watch(target.eventId)).rejects.toThrow('your own participant');
        const denied = new ReplyWatches({...options, path: join(directory, 'denied.json'), allowed: new Set(), request: async () => target});
        await expect(denied.watch(target.eventId)).rejects.toThrow('approved');
        calls = 0;
        const shutdown = new ReplyWatches({...options, path: join(directory, 'shutdown.json')});
        await shutdown.watch(target.eventId);
        const pending = shutdown.tick();
        shutdown.stop();
        resolve({...target, responseEventId: newId('event'), responseText: 'late'});
        await pending;
        expect(notices).toHaveLength(0);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test('transient outages keep a watch pending and recover; corrupt state is never silently replaced', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reply-watch-retry-'));
    const target = request();
    let online = true;
    const notices: ReplyOutcome[] = [];
    const options = {path: join(directory, 'watches.json'), participantId: target.from, allowed: new Set([target.to]), request: async () => {
        if (!online) {
            throw new ProtocolError('server_unavailable', 'offline');
        }
        return target;
    }, notify: async (outcome: ReplyOutcome) => { notices.push(outcome); }};
    try {
        const book = new ReplyWatches(options);
        await book.watch(target.eventId);
        online = false;
        await book.tick();
        expect(book.list()[0]).toMatchObject({state: 'waiting', lastError: 'Reconnecting: offline'});
        expect(notices).toHaveLength(0);
        online = true;
        target.failureAt = Date.now();
        target.failureReason = 'Actual runtime failure';
        await book.tick();
        expect(notices[0]).toMatchObject({state: 'failed', reason: 'Actual runtime failure'});
        writeFileSync(options.path, 'broken');
        expect(() => new ReplyWatches(options)).toThrow();
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

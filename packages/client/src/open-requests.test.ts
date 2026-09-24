import {describe, expect, test} from 'vitest';

import {openRequests, owedByMe, unreceipted} from './open-requests.js';
import type {RoomEvent} from '@pairlobby/protocol';

let seq = 0;
function message(from: string, to: string | null, text: string, replyTo: string | null = null): RoomEvent {
    seq += 1;
    return {
        protocolVersion: 1,
        roomId: 'rm_x',
        seq,
        eventId: `ev_${seq}`,
        senderId: from,
        idempotencyKey: null,
        recipientId: to,
        replyTo,
        at: 1000 * seq,
        type: 'message',
        payload: {text, priority: 'normal'}
    } as RoomEvent;
}
function receipt(from: string, eventId: string): RoomEvent {
    seq += 1;
    return {
        protocolVersion: 1,
        roomId: 'rm_x',
        seq,
        eventId: `ev_${seq}`,
        senderId: from,
        idempotencyKey: null,
        recipientId: null,
        replyTo: null,
        at: 1000 * seq,
        type: 'message.received',
        payload: {eventId}
    } as RoomEvent;
}

describe('open requests', () => {
    test('test_an_addressed_message_with_no_answer_is_open', () => {
        const events = [message('codex', 'claude', 'write a joke to a file')];
        expect(openRequests(events)).toHaveLength(1);
        expect(owedByMe(events, 'claude')).toHaveLength(1);
        expect(owedByMe(events, 'codex')).toHaveLength(0);
    });

    test('test_room_wide_chatter_is_never_an_open_request', () => {
        expect(openRequests([message('codex', null, 'thinking out loud')])).toHaveLength(0);
    });

    test('test_an_explicit_reply_closes_it', () => {
        const ask = message('codex', 'claude', 'write a joke');
        expect(openRequests([ask, message('claude', 'codex', 'done', ask.eventId)])).toHaveLength(0);
    });

    test('test_unthreaded_chatter_does_not_resolve_requests', () => {
        const ask = message('codex', 'claude', 'write a joke');
        expect(owedByMe([ask, message('claude', 'codex', 'working on it')], 'claude')).toHaveLength(1);
    });
    test('test_every_message_to_the_same_recipient_stays_open', () => {
        const first = message('codex', 'claude', 'first');
        const second = message('codex', 'claude', 'second');
        expect(openRequests([first, second]).map((r) => r.eventId)).toEqual([first.eventId, second.eventId]);
        expect(openRequests([first, second, message('claude', 'codex', 'done', first.eventId)]).map((r) => r.eventId)).toEqual([second.eventId]);
    });
    test('test_a_different_participant_cannot_close_or_acknowledge_the_request', () => {
        const ask = message('codex', 'claude', 'private work');
        const requests = openRequests([ask, message('hugo', 'codex', 'done', ask.eventId), receipt('hugo', ask.eventId)]);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.received).toBe(false);
    });
    test('test_progress_does_not_count_as_a_final_reply', () => {
        const ask = message('codex', 'claude', 'work');
        const update = message('claude', 'codex', 'started', ask.eventId);
        if (update.type === 'message') {
            update.payload.responseStage = 'progress';
        }
        expect(openRequests([ask, update])).toHaveLength(1);
    });
    test('test_an_explicit_refusal_counts_as_an_answer', () => {
        const ask = message('codex', 'claude', 'work');
        expect(openRequests([ask, message('claude', 'codex', 'I cannot do this', ask.eventId)])).toHaveLength(0);
    });

    test('test_talking_to_someone_else_does_not_close_it', () => {
        const ask = message('codex', 'claude', 'write a joke');
        const open = openRequests([ask, message('claude', 'hugo', 'unrelated')]);
        // claude still owes codex; the aside to hugo is its own unanswered message.
        expect(open.some((request) => request.eventId === ask.eventId)).toBe(true);
        expect(owedByMe(open.length > 0 ? [ask, message('claude', 'hugo', 'unrelated')] : [], 'claude').some((request) => request.from === 'codex')).toBe(true);
    });

    test('test_a_receipt_marks_it_read_but_not_answered', () => {
        const ask = message('codex', 'claude', 'write a joke');
        const open = openRequests([ask, receipt('claude', ask.eventId)]);
        expect(open).toHaveLength(1);
        expect(open[0]!.received).toBe(true);
    });

    test('unreceipted includes other members messages and broadcasts without creating reply obligations', () => {
        const mine = message('codex', 'claude', 'for claude');
        const theirs = message('codex', 'hugo', 'for hugo');
        const broadcast = message('hugo', null, 'for everyone');
        const own = message('claude', null, 'my own message');
        expect(unreceipted([mine, theirs, broadcast, own], 'claude', true).map((event) => event.eventId)).toEqual([mine.eventId, theirs.eventId, broadcast.eventId]);
        expect(unreceipted([mine, theirs, receipt('claude', mine.eventId)], 'claude', true).map((event) => event.eventId)).toEqual([theirs.eventId]);
        expect(unreceipted([mine, theirs, broadcast, own], 'claude').map((event) => event.eventId)).toEqual([mine.eventId]);
        expect(owedByMe([mine, theirs, broadcast], 'claude').map((request) => request.eventId)).toEqual([mine.eventId]);
    });
});

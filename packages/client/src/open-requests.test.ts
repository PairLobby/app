import {describe, expect, test} from 'vitest';

import {openRequests, owedByMe, unreceipted} from './open-requests.js';
import type {RoomEvent} from '@pairlobby/protocol';

let seq = 0;
function message(from: string, to: string | null, text: string, replyTo: string | null = null): RoomEvent {
    seq += 1;
    return {protocolVersion: 1, roomId: 'rm_x', seq, eventId: `ev_${seq}`, senderId: from, idempotencyKey: null, recipientId: to, replyTo, at: 1000 * seq, type: 'message', payload: {text, priority: 'normal'}} as RoomEvent;
}
function receipt(from: string, eventId: string): RoomEvent {
    seq += 1;
    return {protocolVersion: 1, roomId: 'rm_x', seq, eventId: `ev_${seq}`, senderId: from, idempotencyKey: null, recipientId: null, replyTo: null, at: 1000 * seq, type: 'message.received', payload: {eventId}} as RoomEvent;
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

    // Requiring replyTo would report an agent that answered in plain conversation
    // as ignoring the request, and a warning that lies stops being read.
    test('test_answering_in_conversation_closes_it_without_replyTo', () => {
        const ask = message('codex', 'claude', 'write a joke');
        expect(openRequests([ask, message('claude', 'codex', 'saved to ~/Desktop/joke.txt')])).toHaveLength(0);
    });

    test('test_declining_out_loud_closes_it_too', () => {
        const ask = message('codex', 'claude', 'write a joke');
        expect(openRequests([ask, message('claude', 'codex', 'I will not write to the Desktop')])).toHaveLength(0);
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

    test('test_unreceipted_finds_only_what_this_participant_owes_a_receipt_for', () => {
        const mine = message('codex', 'claude', 'for claude');
        const theirs = message('codex', 'hugo', 'for hugo');
        expect(unreceipted([mine, theirs], 'claude').map((event) => event.eventId)).toEqual([mine.eventId]);
        expect(unreceipted([mine, theirs, receipt('claude', mine.eventId)], 'claude')).toHaveLength(0);
    });
});

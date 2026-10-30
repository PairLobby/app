import {expect, test} from 'vitest';
import type {MessageRequest, RoomEvent} from '@pairlobby/protocol';
import {ReceiptView} from '../src/receipt-view.js';

const message: RoomEvent = {protocolVersion: 1, roomId: 'rm_test', eventId: 'ev_message', seq: 1, senderId: 'pt_sender', recipientId: 'pt_codex', replyTo: null, idempotencyKey: null, at: 100, type: 'message', payload: {text: 'hello', priority: 'normal'}};

function receipt(participantId: string, at: number): RoomEvent {
    return {...message, eventId: `ev_receipt_${at}`, senderId: participantId, at, type: 'message.received', payload: {eventId: message.eventId}};
}

test('only confirmed receipts create Seen; rendering a message or receiving a reply does not', () => {
    const view = new ReceiptView();
    view.observe(message);
    view.observe({...message, eventId: 'ev_reply', senderId: 'pt_codex', replyTo: message.eventId});
    expect(view.forMessage(message.eventId)).toEqual([]);
    view.observe(receipt('pt_codex', 200));
    expect(view.forMessage(message.eventId)).toEqual([{participantId: 'pt_codex', acknowledgedAt: 200}]);
});

test('out-of-order duplicate receipts retain the original acknowledgement time and correct people', () => {
    const view = new ReceiptView();
    view.observe(receipt('pt_codex', 300));
    view.observe(receipt('pt_codex', 200));
    view.observe(receipt('pt_claude', 400));
    view.observe(message);
    expect(view.forMessage(message.eventId)).toEqual([{participantId: 'pt_codex', acknowledgedAt: 200}, {participantId: 'pt_claude', acknowledgedAt: 400}]);
    expect(view.forMessage('ev_unrelated')).toEqual([]);
});

test('durable request state recovers receipts after the receipt event is no longer in retained history', () => {
    const view = new ReceiptView();
    const request: MessageRequest = {roomId: 'rm_test', eventId: message.eventId, seq: 1, from: 'pt_sender', to: 'pt_codex', text: 'hello', at: 100, requiresReply: true, receivedAt: null, responseEventId: null, respondedAt: null, progressAt: null};
    view.observeRequest(request);
    expect(view.forMessage(message.eventId)).toEqual([]);
    view.observeRequest({...request, receivedAt: 200});
    expect(view.forMessage(message.eventId)).toEqual([{participantId: 'pt_codex', acknowledgedAt: 200}]);
});

test('test_a_watermark_confirms_every_message_up_to_it_except_for_its_sender_and_never_a_later_one', () => {
    const view = new ReceiptView();
    const later: RoomEvent = {...message, eventId: 'ev_later', seq: 5};
    view.observe(message);
    view.observe(later);
    view.observeReceipts([{participantId: 'pt_codex', throughSeq: 3, revision: 1, at: 250}, {participantId: 'pt_sender', throughSeq: 9, revision: 2, at: 260}]);
    expect(view.forMessage(message.eventId)).toEqual([{participantId: 'pt_codex', acknowledgedAt: 250}]);
    expect(view.forMessage(later.eventId)).toEqual([]);
    view.observeReceipts([{participantId: 'pt_codex', throughSeq: 2, revision: 3, at: 270}]);
    expect(view.forMessage(message.eventId)).toEqual([{participantId: 'pt_codex', acknowledgedAt: 250}]);
    view.observe(receipt('pt_codex', 200));
    expect(view.forMessage(message.eventId)).toEqual([{participantId: 'pt_codex', acknowledgedAt: 200}]);
});

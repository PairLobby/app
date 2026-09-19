import {expect, test} from 'vitest';
import type {MessageRequest, RoomEvent} from '@pairlobby/protocol';
import {format, formatRequestStatus} from './chat.js';

const names = new Map([['pt_human', 'hjoncour'], ['pt_codex', 'codex']]);
const event: RoomEvent = {
    protocolVersion: 1, roomId: 'rm_test', eventId: 'ev_request', seq: 1,
    senderId: 'pt_human', recipientId: 'pt_codex', replyTo: null,
    idempotencyKey: 'test', at: Date.now(), type: 'message',
    payload: {text: 'Hey @codex, tell claude to say hi in the chat', priority: 'normal'}
};
const request: MessageRequest = {
    roomId: 'rm_test', eventId: 'ev_request', seq: 1, from: 'pt_human', to: 'pt_codex',
    text: 'hello', at: Date.now(), requiresReply: true, receivedAt: null,
    responseEventId: null, respondedAt: null, progressAt: null
};

function plain(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

test('normal chat shows sender and recipient without protocol IDs on requests or replies', () => {
    const rendered = plain(format(event, names, 'pt_human'));
    expect(rendered).toContain('hjoncour → codex');
    expect(rendered).toContain(event.payload.text);
    expect(rendered).not.toContain('ev_request');
    expect(rendered).not.toContain('[request');
    const reply = {...event, eventId: 'ev_reply', senderId: 'pt_codex', recipientId: 'pt_human', replyTo: 'ev_request'};
    expect(plain(format(reply, names, 'pt_human'))).not.toContain('ev_');
    expect(plain(format(reply, names, 'pt_human', true))).toContain('reply to ev_request');
    expect(plain(format(event, names, 'pt_human', true))).toContain('request ev_request');
});

test('normal delivery statuses use readable wording and reserve IDs for debug display', () => {
    expect(formatRequestStatus(request, names)).toBe('hjoncour → codex: Waiting for acknowledgement');
    expect(formatRequestStatus({...request, receivedAt: Date.now()}, names)).toContain('Acknowledged · waiting for reply');
    expect(formatRequestStatus(request, names, true)).toContain('[ev_request]');
    const failure: RoomEvent = {...event, type: 'message.delivery_failed', payload: {eventId: 'ev_request', reason: 'Runtime unavailable'}};
    expect(format(failure, names, 'pt_human')).not.toContain('ev_request');
    expect(format(failure, names, 'pt_human', true)).toContain('ev_request');
});

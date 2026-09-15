//! Sequence assignment and quota accounting. The server assigns sender identity
//! and sequence; a client never supplies either.

import {DEFAULT_ROOM_POLICY, ProtocolError, isQuotaExempt, payloadBytes} from '@pairlobby/protocol';
import type {EventBody, RoomEvent, RoomRecord} from '@pairlobby/protocol';

import type {CoreContext} from './state.js';

export interface AppendInput {
    senderId: string | null;
    idempotencyKey: string | null;
    recipientId: string | null;
    replyTo: string | null;
    body: EventBody;
}

export interface Appended {
    room: RoomRecord;
    event: RoomEvent;
}

export function appendEvent(room: RoomRecord, input: AppendInput, ctx: CoreContext): Appended {
    const bytes = payloadBytes(input.body);
    if (bytes > room.policy.maxEventPayloadBytes) {
        throw new ProtocolError('payload_too_large', `payload is ${bytes} bytes; the limit is ${room.policy.maxEventPayloadBytes}`);
    }
    const response=input.body.type==='message' && input.replyTo!==null;
    if (!isQuotaExempt(input.body.type) && !response) {
        if (room.retainedEvents + 1 > room.policy.maxRetainedEvents) throw new ProtocolError('quota_exceeded', 'this room has reached its retained event limit; control, close, and export remain available');
        if (room.retainedEventBytes + bytes > room.policy.maxRetainedEventBytes) throw new ProtocolError('quota_exceeded', 'this room has reached its retained byte limit; control, close, and export remain available');
    }
    const event = {
        protocolVersion: 1,
        roomId: room.roomId,
        seq: room.nextSeq,
        eventId: ctx.newEventId(),
        senderId: input.senderId,
        idempotencyKey: input.idempotencyKey,
        recipientId: input.recipientId,
        replyTo: input.replyTo,
        at: ctx.now,
        ...input.body,
    } as RoomEvent;
    const next: RoomRecord = {
        ...room,
        nextSeq: room.nextSeq + 1,
        retainedEvents: room.retainedEvents + 1,
        retainedEventBytes: room.retainedEventBytes + bytes,
    };
    return {room: next, event};
}

export {DEFAULT_ROOM_POLICY};

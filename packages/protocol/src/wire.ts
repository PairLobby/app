//! Live-connection framing. A socket delivery is not proof an agent read
//! anything: accepted-by-server, delivered-to-client, and explicitly
//! acknowledged stay three separate facts.

import {z} from 'zod';

import {ErrorResponse} from './http.js';
import {RoomEvent} from './events.js';
import {RoomSnapshot} from './records.js';

/**
 * Sent once at upgrade, before any live event. Replaying history up to
 * `watermarkSeq` and then applying subsequent frames closes the race between a
 * paginated read and the live subscription.
 */
export const ServerHello = z.object({
    type: z.literal('hello'),
    snapshot: RoomSnapshot,
    watermarkSeq: z.number().int().nonnegative(),
});

export const ServerEventFrame = z.object({type: z.literal('event'), event: RoomEvent});
export const ServerErrorFrame = z.intersection(z.object({type: z.literal('error'), fatal: z.boolean()}), ErrorResponse);

export const ServerFrame = z.union([ServerHello, ServerEventFrame, ServerErrorFrame]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Consumption acknowledgement, separate from delivery: it moves the participant's read cursor. */
export const ClientAckFrame = z.object({type: z.literal('ack'), throughSeq: z.number().int().nonnegative()});

export const ClientFrame = ClientAckFrame;
export type ClientFrame = z.infer<typeof ClientFrame>;

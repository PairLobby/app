//! Schemas for rooms that close themselves. Kept apart so records, events and
//! requests can share them without importing each other.

import {z} from 'zod';

const durationMs = z.number().int().min(1000).max(10 * 365 * 24 * 3600_000);

export const AutoClosePolicySchema = z.discriminatedUnion('mode', [
    z.object({mode: z.literal('off')}),
    z.object({mode: z.literal('inactivity'), afterMs: durationMs}),
    z.object({mode: z.literal('age'), afterMs: durationMs}),
    z.object({mode: z.literal('agents_and_guests_left')})
]);

export const CloseReasonSchema = z.enum(['manual', 'inactivity', 'age', 'agents_and_guests_left']);

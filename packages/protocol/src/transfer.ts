//! Moving a room to another relay: every row the room owns, streamed as NDJSON
//! records, so the receiving relay ends up with the same state and every existing
//! credential keeps working there.

import {z} from 'zod';

import {MovedToSchema} from './auto-close.js';
import {RoomEvent} from './events.js';
import {FILE_CHUNK_BYTES, FileRecord} from './files.js';
import {EventId, ParticipantId} from './ids.js';
import {ControlRecord, HandoverRecord, ParticipantRecord, RoomRecord} from './records.js';

/** How long a relay refuses writes to a room being moved, unless the mover renews or finishes. */
export const MOVE_LEASE_MS = 10 * 60_000;

export const TransferRequestRow = z.object({eventId: EventId, seq: z.number().int().min(1), receivedAt: z.number().int().nonnegative().nullable(), responseEventId: EventId.nullable(), requiresReply: z.boolean(), body: z.record(z.unknown())});
export type TransferRequestRow = z.infer<typeof TransferRequestRow>;

export const RoomTransferRecord = z.discriminatedUnion('kind', [
    z.object({kind: z.literal('room'), room: RoomRecord.passthrough(), earliestSeq: z.number().int().min(1)}),
    z.object({kind: z.literal('participant'), participant: ParticipantRecord.passthrough()}),
    z.object({kind: z.literal('handover'), handover: HandoverRecord.passthrough()}),
    z.object({kind: z.literal('control'), control: ControlRecord.passthrough()}),
    z.object({kind: z.literal('event'), event: RoomEvent}),
    z.object({kind: z.literal('request'), request: TransferRequestRow}),
    z.object({kind: z.literal('receipt-range'), participantId: ParticipantId, throughSeq: z.number().int().nonnegative(), at: z.number().int().nonnegative()}),
    z.object({kind: z.literal('idempotency'), key: z.string().min(1).max(128), requestDigest: z.string().min(1).max(64 * 1024), seq: z.number().int().min(1)}),
    z.object({kind: z.literal('file'), file: FileRecord.passthrough()}),
    // An older importer must refuse these records instead of silently dropping a file's lifetime policy.
    z.object({kind: z.literal('file-retention'), file: FileRecord.passthrough()}),
    z.object({kind: z.literal('file-chunk'), fileId: z.string().min(1).max(64), index: z.number().int().nonnegative(), bytes: z.string().max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4)}),
    z.object({kind: z.literal('complete'), events: z.number().int().nonnegative(), files: z.number().int().nonnegative(), digest: z.string().length(64)})
]);
export type RoomTransferRecord = z.infer<typeof RoomTransferRecord>;

/** `POST /v1/rooms/:id/move/commit`: the room now lives at `movedTo`, so it closes here. */
export const MoveCommitRequest = z.object({movedTo: MovedToSchema});
export type MoveCommitRequest = z.infer<typeof MoveCommitRequest>;

/** Answer to `POST /v1/rooms/:id/move/prepare`: writes are refused until `until`, unless the move finishes or is aborted first. */
export const MovePrepareResponse = z.object({until: z.number().int().nonnegative()});
export type MovePrepareResponse = z.infer<typeof MovePrepareResponse>;

/**
 * A running SHA-256 over a room's events in seq order, each as the JSON text it was
 * stored with. Both relays compute it, so a move is only finished when they agree.
 */
export class TransferDigest {
    private current = '0'.repeat(64);
    count = 0;

    async add(eventJson: string): Promise<void> {
        const bytes = new TextEncoder().encode(this.current + eventJson);
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
        this.current = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
        this.count++;
    }

    get value(): string {
        return this.current;
    }
}

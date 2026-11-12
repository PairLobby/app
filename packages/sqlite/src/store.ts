import {FILE_CHUNK_BYTES, ProtocolError, TransferDigest, mergeMessageRequest} from '@pairlobby/protocol';

import type {ControlRecord, DefaultVisibility, FileRecord, HandoverRecord, InviteRecord, ListingRecord, LocalRoom, MessageRequest, ParticipantRecord, RequestPage, RoomEvent, RoomRecord, RoomTransferRecord} from '@pairlobby/protocol';
import type {Mutation, RoomView} from '@pairlobby/room-core';
import {committedRoom, mutationChanges, eventPage, requestPage, receivedRequest, MAX_PAGE_RECORDS} from '@pairlobby/server-core';
import type {CommittedChange, DirectoryStore, EventPage, FileStore, IdempotencyRecord, JsonRow, RoomHead, RoomLoadOptions, RoomStore} from '@pairlobby/server-core';

import {SCHEMA, SCHEMA_VERSION} from './schema.js';
import {REQUEST_BACKFILL_SQL} from './request-backfill.js';
import type {SqlDatabase, SqlTransaction, SqliteStoreOptions} from './driver.js';

type IdempotencyKey = {key: string; requestDigest: string} | null;

interface BodyRow {
    body: string;
}

type UploadRecord = FileRecord & {uploading: true; uploadedBytes: number; chunks: number};
type RequestRow = {event_id: string; seq: number; received_at: number | null; response_event_id: string | null; requires_reply: number; body: string};
export type TransferredRoom = {roomId: string; events: number; files: number};

/** SQLite implementation shared by Node and Durable Objects; all platform APIs stay in their drivers. */
export const VISIBLE_EVENT_SQL = 'seq >= (SELECT earliest_seq FROM rooms WHERE rooms.room_id = events.room_id)';
export const VISIBLE_FILE_SQL = "(event_id IS NULL OR NOT EXISTS (SELECT 1 FROM events JOIN rooms ON rooms.room_id = events.room_id WHERE events.room_id = files.room_id AND json_extract(events.body, '$.eventId') = files.event_id AND events.seq < rooms.earliest_seq))";
export type ListedRoom = LocalRoom & {expiresAt: number | null};

/** Requests have their own sequence space; legacy records resolve their transcript sequence through the indexed event ID. */
export const REQUEST_MESSAGE_SEQ_SQL = "coalesce(json_extract(r.body,'$.messageSeq'), (SELECT seq FROM events e WHERE e.room_id=r.room_id AND json_extract(e.body,'$.eventId')=coalesce(json_extract(r.body,'$.conversationId'),r.event_id)), r.seq)";
const RECEIVED_AT_SQL = `coalesce(r.received_at, (SELECT at FROM receipt_ranges q WHERE q.room_id=r.room_id AND q.participant_id=json_extract(r.body,'$.to') AND q.through_seq>=${REQUEST_MESSAGE_SEQ_SQL} ORDER BY q.through_seq LIMIT 1))`;
const REQUEST_SELECT = `SELECT r.body, ${RECEIVED_AT_SQL} AS receivedAt FROM message_requests r`;

/** Drop at most one maintenance page of ranges whose first-received timestamp no retained request still needs. */
export const PRUNE_RECEIPT_RANGES_SQL = `DELETE FROM receipt_ranges WHERE (room_id,participant_id,through_seq) IN (
    SELECT q.room_id,q.participant_id,q.through_seq FROM receipt_ranges q WHERE q.room_id=? AND NOT EXISTS (
        SELECT 1 FROM message_requests r WHERE r.room_id=q.room_id AND json_extract(r.body,'$.to')=q.participant_id AND r.received_at IS NULL
        AND json_extract(r.body,'$.messageSeq')<=q.through_seq AND json_extract(r.body,'$.messageSeq')>coalesce((
            SELECT max(p.through_seq) FROM receipt_ranges p WHERE p.room_id=q.room_id AND p.participant_id=q.participant_id AND p.through_seq<q.through_seq
        ),0)
    ) LIMIT 500
)`;

export class SqliteStore implements RoomStore {
    private readonly transaction: SqlTransaction;
    private pendingChanges: CommittedChange[] | null = null;
    readonly files: FileStore = {
        putFile: async (file, bytes, limitBytes, expectedStateRevision) => this.transaction(() => {
            this.assertNotMoving(file.roomId);
            const held = this.db.prepare('SELECT coalesce(sum(size), 0) AS total FROM files WHERE room_id = ?').get(file.roomId) as {total: number};
            if (Number(held.total) + file.size > limitBytes) {
                return false;
            }
            this.bumpRoom(file.roomId, expectedStateRevision);
            this.options.beforeFileReservation?.(file);
            this.db.prepare('INSERT INTO files (file_id, room_id, size, created_at, event_id, body) VALUES (?, ?, ?, ?, ?, ?)').run(file.fileId, file.roomId, file.size, file.createdAt, file.eventId, JSON.stringify(file));
            const insert = this.db.prepare('INSERT INTO file_chunks (file_id, idx, bytes) VALUES (?, ?, ?)');
            for (let offset = 0, index = 0; offset < bytes.byteLength; offset += FILE_CHUNK_BYTES, index++) {
                insert.run(file.fileId, index, bytes.subarray(offset, offset + FILE_CHUNK_BYTES));
            }
            return true;
        }),
        file: async (roomId, fileId) => {
            const row = this.db.prepare(`SELECT body FROM files WHERE room_id = ? AND file_id = ? AND coalesce(json_extract(body,'$.uploading'),0)=0 AND ${VISIBLE_FILE_SQL}`).get(roomId, fileId) as BodyRow | undefined;
            return row ? (JSON.parse(row.body) as FileRecord) : null;
        },
        fileBytes: async (roomId, fileId) => {
            const file = this.db.prepare(`SELECT size FROM files WHERE room_id = ? AND file_id = ? AND coalesce(json_extract(body,'$.uploading'),0)=0 AND ${VISIBLE_FILE_SQL}`).get(roomId, fileId) as {size: number} | undefined;
            if (!file) {
                return null;
            }
            const bytes = new Uint8Array(Number(file.size));
            let offset = 0;
            for (const chunk of this.db.prepare('SELECT bytes FROM file_chunks WHERE file_id = ? ORDER BY idx').all(fileId) as {bytes: Uint8Array | ArrayBuffer}[]) {
                bytes.set(chunk.bytes instanceof Uint8Array ? chunk.bytes : new Uint8Array(chunk.bytes), offset);
                offset += chunk.bytes.byteLength;
            }
            return offset === bytes.byteLength ? bytes : null;
        },
        attachedFiles: async (roomId) => (this.db.prepare(`SELECT body FROM files WHERE room_id = ? AND event_id IS NOT NULL AND ${VISIBLE_FILE_SQL} ORDER BY created_at, file_id`).all(roomId) as unknown as BodyRow[]).map((row) => JSON.parse(row.body) as FileRecord),
        usedBytes: async (roomId) => Number((this.db.prepare(`SELECT coalesce(sum(size), 0) AS total FROM files WHERE room_id = ? AND ${VISIBLE_FILE_SQL}`).get(roomId) as {total: number}).total),
        deleteUnattachedFiles: async (roomId, before) => this.transaction(() => {
            this.db.prepare('DELETE FROM file_chunks WHERE file_id IN (SELECT file_id FROM files WHERE room_id = ? AND event_id IS NULL AND created_at < ?)').run(roomId, before);
            const result = this.db.prepare('DELETE FROM files WHERE room_id = ? AND event_id IS NULL AND created_at < ?').run(roomId, before);
            if (Number(result.changes) > 0) {
                this.bumpRoom(roomId);
            }
        }),
        createUpload: async (file, limitBytes, expectedStateRevision) => this.transaction(() => {
            this.assertNotMoving(file.roomId);
            const held = this.db.prepare('SELECT coalesce(sum(size),0) AS total FROM files WHERE room_id=?').get(file.roomId) as {total: number};
            if (Number(held.total) + file.size > limitBytes) {
                return false;
            }
            this.bumpRoom(file.roomId, expectedStateRevision);
            this.options.beforeFileReservation?.(file);
            const pending: UploadRecord = {...file, uploading: true, uploadedBytes: 0, chunks: 0};
            this.db.prepare('INSERT INTO files(file_id,room_id,size,created_at,event_id,body) VALUES(?,?,?,?,NULL,?)').run(file.fileId, file.roomId, file.size, file.createdAt, JSON.stringify(pending));
            return true;
        }),
        writeChunk: async (roomId, fileId, index, bytes) => this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM files WHERE room_id=? AND file_id=? AND event_id IS NULL').get(roomId, fileId) as BodyRow | undefined;
            const file = row ? JSON.parse(row.body) as UploadRecord : null;
            if (!file?.uploading || file.chunks !== index || bytes.byteLength > FILE_CHUNK_BYTES || file.uploadedBytes + bytes.byteLength > file.size) {
                throw new ProtocolError('invalid_request', 'the upload is no longer available or its chunks are out of order');
            }
            this.db.prepare('INSERT INTO file_chunks(file_id,idx,bytes) VALUES(?,?,?)').run(fileId, index, bytes);
            this.db.prepare('UPDATE files SET body=? WHERE file_id=?').run(JSON.stringify({...file, chunks: index + 1, uploadedBytes: file.uploadedBytes + bytes.byteLength}), fileId);
        }),
        completeUpload: async (file, expectedStateRevision) => this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM files WHERE room_id=? AND file_id=? AND event_id IS NULL').get(file.roomId, file.fileId) as BodyRow | undefined;
            const pending = row ? JSON.parse(row.body) as UploadRecord : null;
            if (!pending?.uploading || pending.uploadedBytes !== file.size || pending.size !== file.size) {
                throw new ProtocolError('invalid_request', 'the upload did not finish');
            }
            this.bumpRoom(file.roomId, expectedStateRevision);
            this.db.prepare('UPDATE files SET body=? WHERE file_id=?').run(JSON.stringify(file), file.fileId);
        }),
        cancelUpload: async (roomId, fileId) => this.transaction(() => {
            const pending = this.db.prepare("SELECT 1 FROM files WHERE room_id=? AND file_id=? AND json_extract(body,'$.uploading')=1").get(roomId, fileId);
            if (pending) {
                this.db.prepare('DELETE FROM file_chunks WHERE file_id=?').run(fileId);
                this.db.prepare('DELETE FROM files WHERE file_id=?').run(fileId);
                this.bumpRoom(roomId);
            }
        }),
        fileStream: async (roomId, fileId) => {
            const file = await this.files.file(roomId, fileId);
            if (!file) {
                return null;
            }
            const db = this.db;
            let index = 0;
            let offset = 0;
            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (offset === file.size) {
                        controller.close();
                        return;
                    }
                    const row = db.prepare('SELECT bytes FROM file_chunks WHERE file_id=? AND idx=?').get(fileId, index++) as {bytes: Uint8Array | ArrayBuffer} | undefined;
                    if (!row || row.bytes.byteLength === 0 || offset + row.bytes.byteLength > file.size) {
                        controller.error(new ProtocolError('server_unavailable', 'the stored file is incomplete'));
                        return;
                    }
                    const chunk = row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes);
                    offset += chunk.byteLength;
                    controller.enqueue(chunk);
                }
            }, {highWaterMark: 0});
        },
    };

    /** The agent directory, in the same database as the rooms its listings point into. */
    readonly directory: DirectoryStore = {
        putListing: async (listing) => {
            this.db.prepare('INSERT INTO listings (listing_id, room_id, participant_id, owner, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (listing_id) DO UPDATE SET owner = excluded.owner, body = excluded.body').run(listing.listingId, listing.roomId, listing.participantId, listing.owner, JSON.stringify(listing));
        },
        listing: async (listingId) => {
            const row = this.db.prepare('SELECT body FROM listings WHERE listing_id = ?').get(listingId) as BodyRow | undefined;
            return row ? (JSON.parse(row.body) as ListingRecord) : null;
        },
        listingFor: async (roomId, participantId) => {
            const row = this.db.prepare('SELECT body FROM listings WHERE room_id = ? AND participant_id = ?').get(roomId, participantId) as BodyRow | undefined;
            return row ? (JSON.parse(row.body) as ListingRecord) : null;
        },
        deleteListing: async (listingId) => {
            this.db.prepare('DELETE FROM listings WHERE listing_id = ?').run(listingId);
        },
        ownerListings: async (owner, after = '', limit = 500) => (this.db.prepare('SELECT body FROM listings WHERE owner=? AND listing_id>? ORDER BY listing_id LIMIT ?').all(owner, after, limit) as unknown as BodyRow[]).map((row) => JSON.parse(row.body) as ListingRecord),
        listings: async (after, limit) => (this.db.prepare('SELECT body FROM listings WHERE listing_id > ? ORDER BY listing_id LIMIT ?').all(after, limit) as unknown as BodyRow[]).map((row) => JSON.parse(row.body) as ListingRecord),
        lastMessageAt: async (roomId, participantId) => {
            const row = this.db.prepare("SELECT json_extract(body, '$.at') AS at FROM events WHERE room_id = ? AND json_extract(body, '$.senderId') = ? AND json_extract(body, '$.type') = 'message' ORDER BY seq DESC LIMIT 1").get(roomId, participantId) as {at: number} | undefined;
            return row ? Number(row.at) : null;
        },
        memberDefault: async (handle) => {
            const row = this.db.prepare('SELECT body FROM member_defaults WHERE handle = ?').get(handle) as BodyRow | undefined;
            return row ? (JSON.parse(row.body) as DefaultVisibility) : null;
        },
        setMemberDefault: async (handle, visibility) => {
            this.db.prepare('INSERT INTO member_defaults (handle, body) VALUES (?, ?) ON CONFLICT (handle) DO UPDATE SET body = excluded.body').run(handle, JSON.stringify(visibility));
        },
    };

    constructor(protected readonly db: SqlDatabase, transaction: SqlTransaction, private readonly options: SqliteStoreOptions = {}) {
        this.transaction = (action) => {
            const parent = this.pendingChanges;
            const pending: CommittedChange[] = [];
            this.pendingChanges = pending;
            try {
                const result = transaction(action);
                this.pendingChanges = parent;
                if (parent) {
                    parent.push(...pending);
                } else {
                    pending.forEach((change) => this.notify(change));
                }
                return result;
            } finally {
                this.pendingChanges = parent;
            }
        };
        const hasMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
        const schemaVersion = hasMeta ? Number((this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as {value: string} | undefined)?.value ?? 1) : 1;
        if (schemaVersion > SCHEMA_VERSION) {
            throw new Error(`this database uses schema ${schemaVersion}; this relay understands up to ${SCHEMA_VERSION}`);
        }
        this.db.exec(SCHEMA);
        if (!this.db.prepare("SELECT value FROM meta WHERE key='message_requests_v1'").get()) {
            this.transaction(() => this.db.exec(REQUEST_BACKFILL_SQL));
        }
        if (!this.db.prepare("SELECT value FROM meta WHERE key='message_seq_v1'").get()) {
            this.transaction(() => {
                this.db.exec(`UPDATE message_requests AS r SET body=json_set(body,'$.messageSeq',${REQUEST_MESSAGE_SEQ_SQL}) WHERE json_extract(body,'$.messageSeq') IS NULL`);
                this.db.exec("INSERT INTO meta(key,value) VALUES('message_seq_v1','complete')");
            });
        }
        if (!this.db.prepare("SELECT value FROM meta WHERE key='receipt_ranges_v1'").get()) {
            this.transaction(() => {
                this.db.exec("INSERT OR IGNORE INTO receipt_ranges(room_id,participant_id,through_seq,at) SELECT room_id,receipt.key,json_extract(receipt.value,'$.throughSeq'),json_extract(receipt.value,'$.at') FROM rooms,json_each(rooms.body,'$.receipts') receipt");
                this.db.exec("INSERT INTO meta(key,value) VALUES('receipt_ranges_v1','complete')");
            });
        }
        this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value').run('schema_version', String(SCHEMA_VERSION));
    }

    async createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void> {
        this.transaction(() => {
            this.options.beforeApply?.({room, appendEvent: event, upsertParticipants: [participant], upsertHandovers: [], upsertControls: []});
            this.db.prepare('INSERT INTO rooms (room_id, earliest_seq, body) VALUES (?, 1, ?)').run(room.roomId, JSON.stringify(room));
            this.writeParticipant(participant);
            this.writeEvent(event);
        });
        this.notify({roomId: room.roomId, stateRevision: room.stateRevision ?? 0, event});
    }

    async roomHead(roomId: string): Promise<RoomHead | null> {
        const row = this.db.prepare('SELECT earliest_seq, body FROM rooms WHERE room_id = ?').get(roomId) as {earliest_seq: number; body: string} | undefined;
        return row ? {room: JSON.parse(row.body) as RoomRecord, earliestSeq: row.earliest_seq} : null;
    }

    async loadRoom(roomId: string, options: RoomLoadOptions = {}): Promise<RoomView | null> {
        const row = this.db.prepare('SELECT earliest_seq, body FROM rooms WHERE room_id = ?').get(roomId) as {earliest_seq: number; body: string} | undefined;
        if (!row) {
            return null;
        }
        return {
            room: JSON.parse(row.body) as RoomRecord,
            participants: this.rows('SELECT body FROM participants WHERE room_id = ? ORDER BY participant_id', roomId),
            handovers: options.handovers === false ? [] : this.rows('SELECT body FROM handovers WHERE room_id = ? ORDER BY handover_id', roomId),
            controls: this.rows('SELECT body FROM controls WHERE room_id = ? ORDER BY target_participant_id', roomId),
            earliestSeq: row.earliest_seq
        };
    }

    async apply(mutation: Mutation, idempotency: IdempotencyKey): Promise<void> {
        this.transaction(() => {
            const {appendEvent} = mutation;
            if (!(appendEvent.type === 'room.closed' && appendEvent.payload.reason === 'moved')) {
                this.assertNotMoving(mutation.room.roomId);
            }
            if (mutation.expectedTurnRevision !== undefined) {
                this.checkTurnRevision(mutation.room, mutation.expectedTurnRevision);
            }
            const current = this.db.prepare('SELECT body FROM rooms WHERE room_id=?').get(mutation.room.roomId) as BodyRow | undefined;
            if (!current || JSON.parse(current.body).nextSeq !== mutation.appendEvent.seq) {
                throw new ProtocolError('turn_conflict', 'concurrent room mutation; retry with the same idempotency key');
            }
            const previous = JSON.parse(current.body) as RoomRecord;
            const changes = mutationChanges(mutation);
            const room = committedRoom(previous, mutation.room, {...changes, requests: changes.requests || this.receiptsChangeRequests(previous, mutation.room)});
            this.options.beforeApply?.({...mutation, room});
            this.db.prepare('UPDATE rooms SET body = ? WHERE room_id = ?').run(JSON.stringify(room), room.roomId);
            this.writeReceipts(JSON.parse(current.body) as RoomRecord, room);
            for (const participant of mutation.upsertParticipants) this.writeParticipant(participant);
            for (const handover of mutation.upsertHandovers) {
                this.db
                    .prepare('INSERT INTO handovers (handover_id, room_id, body) VALUES (?, ?, ?) ON CONFLICT (handover_id) DO UPDATE SET body = excluded.body')
                    .run(handover.handoverId, handover.roomId, JSON.stringify(handover));
            }
            for (const control of mutation.upsertControls) {
                this.db
                    .prepare(
                        'INSERT INTO controls (room_id, target_participant_id, body) VALUES (?, ?, ?) ON CONFLICT (room_id, target_participant_id) DO UPDATE SET body = excluded.body'
                    )
                    .run(control.roomId, control.targetParticipantId, JSON.stringify(control));
            }
            for (const request of mutation.upsertRequests ?? []) this.writeRequest(request);
            for (const fileId of mutation.attachFiles ?? []) {
                const row = this.db.prepare("SELECT body FROM files WHERE room_id = ? AND file_id = ? AND event_id IS NULL AND coalesce(json_extract(body,'$.uploading'),0)=0").get(mutation.room.roomId, fileId) as BodyRow | undefined;
                if (!row) {
                    throw new ProtocolError('invalid_request', 'an attached file is no longer available; upload it again');
                }
                const file: FileRecord = {...(JSON.parse(row.body) as FileRecord), eventId: mutation.appendEvent.eventId};
                this.db.prepare('UPDATE files SET event_id = ?, body = ? WHERE file_id = ?').run(file.eventId, JSON.stringify(file), fileId);
            }
            this.writeEvent(mutation.appendEvent);
            if (idempotency) {
                this.db
                    .prepare('INSERT INTO idempotency (room_id, key, request_digest, seq) VALUES (?, ?, ?, ?)')
                    .run(mutation.room.roomId, idempotency.key, idempotency.requestDigest, mutation.appendEvent.seq);
            }
        });
        this.notify({roomId: mutation.room.roomId, stateRevision: (mutation.room.stateRevision ?? 0) + 1, event: mutation.appendEvent});
    }

    async readEvents(roomId: string, after: number, limit: number, through = Number.MAX_SAFE_INTEGER): Promise<EventPage> {
        const rows = this.db.prepare(`SELECT body FROM events WHERE room_id = ? AND seq > ? AND seq <= ? AND ${VISIBLE_EVENT_SQL} ORDER BY seq LIMIT ?`).iterate(roomId, after, through, Math.min(limit, MAX_PAGE_RECORDS) + 1) as Iterable<JsonRow>;
        return eventPage(rows, limit);
    }

    async eventBySeq(roomId: string, seq: number): Promise<RoomEvent | null> {
        const row = this.db.prepare(`SELECT body FROM events WHERE room_id = ? AND seq = ? AND ${VISIBLE_EVENT_SQL}`).get(roomId, seq) as BodyRow | undefined;
        return row ? (JSON.parse(row.body) as RoomEvent) : null;
    }

    async eventById(roomId: string, eventId: string): Promise<RoomEvent | null> {
        const row = this.db.prepare(`SELECT body FROM events WHERE room_id = ? AND json_extract(body, '$.eventId') = ? AND ${VISIBLE_EVENT_SQL}`).get(roomId, eventId) as BodyRow | undefined;
        return row ? (JSON.parse(row.body) as RoomEvent) : null;
    }

    async idempotencyRecord(roomId: string, key: string): Promise<IdempotencyRecord | null> {
        const row = this.db.prepare('SELECT request_digest, seq FROM idempotency WHERE room_id = ? AND key = ?').get(roomId, key) as
            | {request_digest: string; seq: number}
            | undefined;
        return row ? {requestDigest: row.request_digest, seq: row.seq} : null;
    }

    async putInvite(invite: InviteRecord, expectedStateRevision?: number): Promise<void> {
        this.transaction(() => {
            this.bumpRoom(invite.roomId, expectedStateRevision);
            this.db.prepare('INSERT INTO invites (digest, room_id, state, bound_attempt_id, body) VALUES (?, ?, ?, ?, ?)').run(invite.digest, invite.roomId, invite.state, invite.boundAttemptId, JSON.stringify(invite));
        });
    }

    async inviteByDigest(digest: string): Promise<InviteRecord | null> {
        const row = this.db.prepare('SELECT body FROM invites WHERE digest = ?').get(digest) as BodyRow | undefined;
        return row ? (JSON.parse(row.body) as InviteRecord) : null;
    }

    /** Open, unexpired rooms that can be joined by name, public or protected: those named `name`, ignoring case, or without a name the newest 50. */
    localJoinRooms(name?: string, now = Date.now()): LocalRoom[] {
        const open = "SELECT room_id, body FROM rooms WHERE (json_extract(body, '$.policy.localJoin') = 1 OR json_extract(body, '$.policy.type') = 'protected') AND json_extract(body, '$.lifecycle') = 'open'";
        const rows = (name === undefined
            ? this.db.prepare(`${open} ORDER BY json_extract(body, '$.createdAt') DESC LIMIT 50`).all()
            : this.db.prepare(`${open} AND lower(json_extract(body, '$.name')) = lower(?)`).all(name)) as {room_id: string; body: string}[];
        const count = this.db.prepare("SELECT count(*) AS active FROM participants WHERE room_id = ? AND json_extract(body, '$.revokedAt') IS NULL AND json_extract(body, '$.leftAt') IS NULL");
        return rows.map((row) => JSON.parse(row.body) as RoomRecord).filter((room) => room.expiresAt === null || room.expiresAt > now).map((room) => ({roomId: room.roomId, name: room.name, createdAt: room.createdAt, participantCount: Number((count.get(room.roomId) as {active: number}).active), type: room.policy.localJoin ? 'public' as const : 'protected' as const}));
    }

    /** Whether any invite digest starts with this lowercase hex prefix; a range over the primary key, not a scan. */
    hasInviteDigestPrefix(prefix: string): boolean {
        return this.db.prepare('SELECT 1 FROM invites WHERE digest >= ? AND digest < ? LIMIT 1').get(prefix, `${prefix}g`) !== undefined;
    }

    /**
     * The conditional UPDATE is the whole point: a second attempt matches no row
     * and gets null, rather than racing the first into membership creation.
     */
    async reserveInvite(digest: string, attemptId: string, credentialHash: string, expectedOccupantId: string | null, expectedStateRevision?: number): Promise<InviteRecord | null> {
        return this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM invites WHERE digest = ?').get(digest) as BodyRow | undefined;
            if (!row) {
                return null;
            }
            const invite = JSON.parse(row.body) as InviteRecord;
            if (invite.boundAttemptId === attemptId) {
                return invite;
            }
            if (invite.state === 'reserved') {
                return null;
            }
            if (invite.state === 'redeemed') {
                if (!invite.reusable) {
                    return null;
                }
                if (invite.redeemedParticipantId !== expectedOccupantId) {
                    return null;
                }
            } else if (expectedOccupantId !== null) {
                return null;
            }
            const reserved: InviteRecord = {...invite, state: 'reserved', boundAttemptId: attemptId, boundCredentialHash: credentialHash};
            // The WHERE clause repeats the precondition so a concurrent writer that
            // slipped in between the read and this update loses rather than overwrites.
            const previous = invite.state === 'redeemed' ? invite.redeemedParticipantId : null;
            const result =
                previous === null ? this.db .prepare("UPDATE invites SET state = 'reserved', bound_attempt_id = ?, body = ? WHERE digest = ? AND state = 'unused'") .run(attemptId, JSON.stringify(reserved), digest) : this.db .prepare( "UPDATE invites SET state = 'reserved', bound_attempt_id = ?, body = ? WHERE digest = ? AND state = 'redeemed' AND json_extract(body, '$.redeemedParticipantId') = ?" ) .run(attemptId, JSON.stringify(reserved), digest, previous);
            if (result.changes === 0) {
                return null;
            }
            this.bumpRoom(invite.roomId, expectedStateRevision);
            return reserved;
        });
    }

    async completeInvite(digest: string, participantId: string, attemptId?: string): Promise<void> {
        this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM invites WHERE digest = ?').get(digest) as BodyRow | undefined;
            if (!row) {
                return;
            }
            const previous = JSON.parse(row.body) as InviteRecord;
            if (attemptId !== undefined && previous.boundAttemptId !== attemptId) {
                throw new ProtocolError('invite_already_redeemed', 'this invite belongs to another redemption attempt');
            }
            if (previous.state === 'redeemed' && previous.redeemedParticipantId === participantId) {
                return;
            }
            const invite = {...previous, state: 'redeemed' as const, redeemedParticipantId: participantId};
            this.db.prepare("UPDATE invites SET state = 'redeemed', body = ? WHERE digest = ?").run(JSON.stringify(invite), digest);
            this.bumpRoom(invite.roomId);
        });
    }

    async participantByCredential(roomId: string, credentialHash: string): Promise<ParticipantRecord | null> {
        const row = this.db.prepare('SELECT body FROM participants WHERE room_id = ? AND credential_hash = ?').get(roomId, credentialHash) as BodyRow | undefined;
        return row ? (JSON.parse(row.body) as ParticipantRecord) : null;
    }

    async handovers(roomId: string): Promise<HandoverRecord[]> {
        return this.rows('SELECT body FROM handovers WHERE room_id = ? ORDER BY handover_id', roomId);
    }

    async messageRequest(roomId: string, eventId: string): Promise<MessageRequest | null> {
        const row = this.db.prepare(`${REQUEST_SELECT} WHERE r.room_id=? AND r.event_id=?`).get(roomId, eventId) as JsonRow | undefined;
        return row ? receivedRequest(row) : null;
    }
    async groupRequests(roomId: string, conversationId: string): Promise<MessageRequest[]> {
        const rows = this.db.prepare(`${REQUEST_SELECT} WHERE r.room_id=? AND json_extract(r.body,'$.conversationId')=? ORDER BY r.seq`).all(roomId, conversationId) as unknown as JsonRow[];
        return rows.map(receivedRequest);
    }

    private checkTurnRevision(room: RoomRecord, expected: number): void {
        const row = this.db.prepare('SELECT body FROM rooms WHERE room_id=?').get(room.roomId) as BodyRow | undefined;
        if (!row || (JSON.parse(row.body).turnRevision ?? 0) !== expected) {
            throw new ProtocolError('turn_conflict', 'the room turn changed; retry');
        }
    }

    async updateTurns(room: RoomRecord, requests: MessageRequest[], expectedRevision: number): Promise<void> {
        this.transaction(() => {
            this.assertNotMoving(room.roomId);
            this.checkTurnRevision(room, expectedRevision);
            const current = this.db.prepare('SELECT body FROM rooms WHERE room_id=?').get(room.roomId) as BodyRow | undefined;
            if (!current || JSON.parse(current.body).nextSeq !== room.nextSeq) {
                throw new ProtocolError('turn_conflict', 'the room changed while renewing the turn');
            }
            const previous = JSON.parse(current.body) as RoomRecord;
            const committed = committedRoom(previous, room, {requests: requests.length > 0 || this.receiptsChangeRequests(previous, room)});
            this.db.prepare('UPDATE rooms SET body=? WHERE room_id=?').run(JSON.stringify(committed), room.roomId);
            this.writeReceipts(JSON.parse(current.body) as RoomRecord, committed);
            for (const request of requests) {
                this.writeRequest(request);
            }
        });
        this.notify({roomId: room.roomId, stateRevision: (room.stateRevision ?? 0) + 1});
    }

    private notify(change: CommittedChange): void {
        try {
            this.options.afterCommit?.(change);
        } catch {
            console.error('pairlobby committed change observer failed');
        }
    }

    async messageRequests(roomId: string, after: number, limit: number, recipientId?: string): Promise<RequestPage> {
        const filter = recipientId === undefined ? '' : " AND json_extract(r.body,'$.to')=?";
        const rows = this.db.prepare(`${REQUEST_SELECT} WHERE r.room_id=? AND r.seq>? AND r.requires_reply=1 AND r.response_event_id IS NULL${filter} ORDER BY r.seq LIMIT ?`)
            .iterate(roomId, after, ...(recipientId === undefined ? [] : [recipientId]), Math.min(limit, MAX_PAGE_RECORDS) + 1) as Iterable<JsonRow>;
        return requestPage(rows, limit);
    }

    async pendingRequestCount(roomId: string): Promise<number> {
        return Number((this.db.prepare('SELECT count(*) AS n FROM message_requests WHERE room_id=? AND requires_reply=1 AND response_event_id IS NULL').get(roomId) as {n: number}).n);
    }
    async unreceivedRequests(roomId: string, recipientId: string, after: number, limit: number): Promise<RequestPage> {
        const rows = this.db
            .prepare(`${REQUEST_SELECT} WHERE r.room_id=? AND r.seq>? AND r.received_at IS NULL AND json_extract(r.body,'$.to')=? AND ${RECEIVED_AT_SQL} IS NULL ORDER BY r.seq LIMIT ?`)
            .iterate(roomId, after, recipientId, Math.min(limit, MAX_PAGE_RECORDS) + 1) as Iterable<JsonRow>;
        return requestPage(rows, limit);
    }

    private writeRequest(request: MessageRequest): void {
        // Keep concurrent receipt/progress writes from erasing an accepted reply.
        const old = this.db.prepare(`${REQUEST_SELECT} WHERE r.event_id=?`).get(request.eventId) as JsonRow | undefined;
        const previous = old ? receivedRequest(old) : null;
        const merged = mergeMessageRequest(previous, request);
        this.db
            .prepare(
                'INSERT INTO message_requests(event_id,room_id,seq,received_at,response_event_id,requires_reply,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET received_at=excluded.received_at,response_event_id=excluded.response_event_id,requires_reply=excluded.requires_reply,body=excluded.body'
            )
            .run(merged.eventId, merged.roomId, merged.seq, merged.receivedAt, merged.responseEventId, merged.requiresReply ? 1 : 0, JSON.stringify(merged));
    }

    private writeReceipts(previous: RoomRecord, room: RoomRecord): void {
        for (const [participantId, mark] of Object.entries(room.receipts ?? {})) {
            const after = previous.receipts?.[participantId]?.throughSeq ?? 0;
            const covers = mark.throughSeq > after && this.db.prepare("SELECT 1 FROM message_requests WHERE room_id=? AND json_extract(body,'$.to')=? AND received_at IS NULL AND json_extract(body,'$.messageSeq')>? AND json_extract(body,'$.messageSeq')<=? LIMIT 1").get(room.roomId, participantId, after, mark.throughSeq);
            if (covers) {
                this.db.prepare('INSERT INTO receipt_ranges(room_id,participant_id,through_seq,at) VALUES(?,?,?,?)').run(room.roomId, participantId, mark.throughSeq, mark.at);
            }
        }
    }

    private receiptsChangeRequests(previous: RoomRecord, room: RoomRecord): boolean {
        for (const [participantId, mark] of Object.entries(room.receipts ?? {})) {
            if (mark.throughSeq <= (previous.receipts?.[participantId]?.throughSeq ?? 0)) {
                continue;
            }
            const pending = this.db.prepare(`SELECT 1 FROM message_requests r WHERE r.room_id=? AND json_extract(r.body,'$.to')=? AND r.requires_reply=1 AND r.response_event_id IS NULL AND r.received_at IS NULL AND ${RECEIVED_AT_SQL} IS NULL AND ${REQUEST_MESSAGE_SEQ_SQL}<=? LIMIT 1`).get(room.roomId, participantId, mark.throughSeq);
            if (pending) {
                return true;
            }
        }
        return false;
    }

    async setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle'], expectedStateRevision?: number): Promise<void> {
        this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM rooms WHERE room_id = ?').get(roomId) as BodyRow | undefined;
            if (!row) {
                return;
            }
            const current = JSON.parse(row.body) as RoomRecord;
            const room = committedRoom(current, {...current, lifecycle, stateRevision: expectedStateRevision ?? current.stateRevision ?? 0}, {snapshot: true});
            this.db.prepare('UPDATE rooms SET body = ? WHERE room_id = ?').run(JSON.stringify(room), roomId);
            this.pendingChanges!.push({roomId, stateRevision: room.stateRevision!});
        });
    }

    /** Physical cleanup. Access was already denied by the lifecycle change. */
    async deleteRoom(roomId: string): Promise<void> {
        this.transaction(() => {
            this.db.prepare('DELETE FROM file_chunks WHERE file_id IN (SELECT file_id FROM files WHERE room_id = ?)').run(roomId);
            for (const table of ['files', 'message_requests', 'receipt_ranges', 'events', 'idempotency', 'handovers', 'controls', 'invites', 'participants', 'listings']) {
                this.db.prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(roomId);
            }
        });
    }

    async dueAutoCloses(now: number, limit: number): Promise<string[]> {
        const rows = this.db
            .prepare("SELECT room_id FROM rooms WHERE json_extract(body, '$.lifecycle') = 'open' AND json_extract(body, '$.autoCloseAt') IS NOT NULL AND json_extract(body, '$.autoCloseAt') <= ? AND (json_extract(body, '$.expiresAt') IS NULL OR json_extract(body, '$.expiresAt') > ?) ORDER BY json_extract(body, '$.autoCloseAt') LIMIT ?")
            .all(now, now, limit) as {room_id: string}[];
        return rows.map((row) => row.room_id);
    }

    async nextAutoCloseAt(now = Date.now()): Promise<number | null> {
        const row = this.db.prepare("SELECT min(json_extract(body, '$.autoCloseAt')) AS at FROM rooms WHERE json_extract(body, '$.lifecycle') = 'open' AND json_extract(body, '$.autoCloseAt') IS NOT NULL AND (json_extract(body, '$.expiresAt') IS NULL OR json_extract(body, '$.expiresAt') > ?)").get(now) as {at: number | null};
        return row.at;
    }

    /** Called inside the same transaction as an invite or other eventless state change. */
    private bumpRoom(roomId: string, expectedStateRevision?: number): void {
        const row = this.db.prepare('SELECT body FROM rooms WHERE room_id = ?').get(roomId) as BodyRow | undefined;
        const current = row ? JSON.parse(row.body) as RoomRecord : null;
        if (!current) {
            throw new ProtocolError('room_not_found', 'no such room');
        }
        const room = committedRoom(current, {...current, stateRevision: expectedStateRevision ?? current.stateRevision ?? 0});
        this.db.prepare('UPDATE rooms SET body = ? WHERE room_id = ?').run(JSON.stringify(room), roomId);
        this.pendingChanges!.push({roomId, stateRevision: room.stateRevision!});
    }

    listedRoom(roomId: string): ListedRoom | null {
        const row = this.db.prepare("SELECT body FROM rooms WHERE room_id = ? AND (json_extract(body, '$.policy.localJoin') = 1 OR json_extract(body, '$.policy.type') = 'protected') AND json_extract(body, '$.lifecycle') = 'open'").get(roomId) as BodyRow | undefined;
        if (!row) {
            return null;
        }
        const room = JSON.parse(row.body) as RoomRecord;
        const {active} = this.db.prepare("SELECT count(*) AS active FROM participants WHERE room_id = ? AND json_extract(body, '$.revokedAt') IS NULL AND json_extract(body, '$.leftAt') IS NULL").get(roomId) as {active: number};
        return {roomId: room.roomId, name: room.name, createdAt: room.createdAt, participantCount: Number(active), type: room.policy.localJoin ? 'public' : 'protected', expiresAt: room.expiresAt};
    }

    hideHistoryBefore(roomId: string, seq: number): void {
        this.db.prepare('UPDATE rooms SET earliest_seq = max(earliest_seq, ?) WHERE room_id = ?').run(seq, roomId);
    }

    /** Boundary for policies that keep the newest message and the context of every unanswered request. */
    protectedHistoryStart(roomId: string): number {
        const pending = this.db.prepare(`SELECT min(${REQUEST_MESSAGE_SEQ_SQL}) AS seq FROM message_requests r WHERE r.room_id=? AND r.requires_reply=1 AND r.response_event_id IS NULL`).get(roomId) as {seq: number | null};
        const newest = this.db.prepare("SELECT max(seq) AS seq FROM events WHERE room_id=? AND json_extract(body,'$.type')='message'").get(roomId) as {seq: number | null};
        return Math.min(pending.seq ?? Infinity, newest.seq ?? Infinity);
    }

    /** Simulates retention dropping the front of the log without touching room state. */
    dropHistoryBefore(roomId: string, seq: number): void {
        this.transaction(() => {
            this.db.prepare('DELETE FROM events WHERE room_id = ? AND seq < ?').run(roomId, seq);
            this.db.prepare('UPDATE rooms SET earliest_seq = ? WHERE room_id = ?').run(seq, roomId);
        });
    }

    /** Until when writes to this room are refused because it is being moved to another relay; null when it is not. */
    moveLease(roomId: string, now = Date.now()): number | null {
        const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(`move_lease:${roomId}`) as {value: string} | undefined;
        const until = row ? Number(row.value) : null;
        return until !== null && until > now ? until : null;
    }

    setMoveLease(roomId: string, until: number | null): void {
        if (until === null) {
            this.db.prepare('DELETE FROM meta WHERE key=?').run(`move_lease:${roomId}`);
            return;
        }
        this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`move_lease:${roomId}`, String(until));
    }

    private assertNotMoving(roomId: string): void {
        if (this.moveLease(roomId) !== null) {
            throw new ProtocolError('room_moving', 'this room is moving to another relay; retry in a moment', {retryAfterMs: 2000});
        }
    }

    /**
     * Every row a move hands to the receiving relay, in the order `transferIn` expects:
     * the room, its members with their credential hashes, handovers, controls, visible
     * events, requests, receipt ranges, idempotency keys, then attached files and their bytes.
     */
    async *transferOut(roomId: string): AsyncGenerator<RoomTransferRecord> {
        const head = this.db.prepare('SELECT earliest_seq, body FROM rooms WHERE room_id=?').get(roomId) as {earliest_seq: number; body: string} | undefined;
        if (!head) {
            throw new ProtocolError('room_not_found', 'no such room');
        }
        const room = JSON.parse(head.body) as RoomRecord;
        yield {kind: 'room', room, earliestSeq: Number(head.earliest_seq)};
        for (const participant of this.rows<ParticipantRecord>('SELECT body FROM participants WHERE room_id=? ORDER BY participant_id', roomId)) {
            yield {kind: 'participant', participant};
        }
        for (const handover of this.rows<HandoverRecord>('SELECT body FROM handovers WHERE room_id=? ORDER BY handover_id', roomId)) {
            yield {kind: 'handover', handover};
        }
        for (const control of this.rows<ControlRecord>('SELECT body FROM controls WHERE room_id=? ORDER BY target_participant_id', roomId)) {
            yield {kind: 'control', control};
        }
        const digest = new TransferDigest();
        for (let after = Number(head.earliest_seq) - 1; ;) {
            const page = this.db.prepare('SELECT seq, body FROM events WHERE room_id=? AND seq>? ORDER BY seq LIMIT 500').all(roomId, after) as {seq: number; body: string}[];
            if (page.length === 0) {
                break;
            }
            for (const row of page) {
                await digest.add(row.body);
                yield {kind: 'event', event: JSON.parse(row.body) as RoomEvent};
            }
            after = Number(page.at(-1)!.seq);
        }
        for (const row of this.db.prepare('SELECT event_id,seq,received_at,response_event_id,requires_reply,body FROM message_requests WHERE room_id=? ORDER BY seq').all(roomId) as RequestRow[]) {
            yield {kind: 'request', request: {eventId: row.event_id, seq: Number(row.seq), receivedAt: row.received_at === null ? null : Number(row.received_at), responseEventId: row.response_event_id, requiresReply: Number(row.requires_reply) === 1, body: JSON.parse(row.body) as Record<string, unknown>}};
        }
        for (const row of this.db.prepare('SELECT participant_id,through_seq,at FROM receipt_ranges WHERE room_id=? ORDER BY participant_id, through_seq').all(roomId) as {participant_id: string; through_seq: number; at: number}[]) {
            yield {kind: 'receipt-range', participantId: row.participant_id, throughSeq: Number(row.through_seq), at: Number(row.at)};
        }
        for (const row of this.db.prepare('SELECT key,request_digest,seq FROM idempotency WHERE room_id=? ORDER BY seq').all(roomId) as {key: string; request_digest: string; seq: number}[]) {
            yield {kind: 'idempotency', key: row.key, requestDigest: row.request_digest, seq: Number(row.seq)};
        }
        const files = this.rows<FileRecord>(`SELECT body FROM files WHERE room_id=? AND event_id IS NOT NULL AND coalesce(json_extract(body,'$.uploading'),0)=0 AND ${VISIBLE_FILE_SQL} ORDER BY created_at, file_id`, roomId);
        for (const file of files) {
            yield {kind: 'file', file};
            for (const chunk of this.db.prepare('SELECT idx, bytes FROM file_chunks WHERE file_id=? ORDER BY idx').all(file.fileId) as {idx: number; bytes: Uint8Array | ArrayBuffer}[]) {
                yield {kind: 'file-chunk', fileId: file.fileId, index: Number(chunk.idx), bytes: toBase64(chunk.bytes instanceof Uint8Array ? chunk.bytes : new Uint8Array(chunk.bytes))};
            }
        }
        yield {kind: 'complete', events: digest.count, files: files.length, digest: digest.value};
    }

    /**
     * Writes a room another relay handed over, all at once, keeping its ids, sequence
     * numbers and credential hashes. `adapt` lets the receiving relay apply its own
     * limits to the room record. Refused, with nothing written, when the room id is
     * already here or the records do not make up one whole room.
     */
    transferIn(records: Iterable<RoomTransferRecord>, adapt: (room: RoomRecord) => RoomRecord = (room) => room): TransferredRoom {
        return this.transaction(() => {
            let room: RoomRecord | undefined;
            let nextSeq = 0;
            const participants = new Set<string>();
            const fileSizes = new Map<string, {size: number; written: number; chunks: number}>();
            let events = 0;
            let complete: Extract<RoomTransferRecord, {kind: 'complete'}> | undefined;
            const refuse = (why: string) => new ProtocolError('invalid_request', `the room cannot be moved here: ${why}`);
            const ours = (roomId: string) => {
                if (roomId !== room!.roomId) {
                    throw refuse('a record belongs to another room');
                }
            };
            for (const record of records) {
                if (complete) {
                    throw refuse('records follow the end of the transfer');
                }
                if (record.kind === 'room') {
                    if (room) {
                        throw refuse('it names two rooms');
                    }
                    if (this.db.prepare('SELECT 1 FROM rooms WHERE room_id=?').get(record.room.roomId)) {
                        throw refuse('a room with this id already exists here');
                    }
                    room = adapt(record.room);
                    nextSeq = record.earliestSeq;
                    this.db.prepare('INSERT INTO rooms (room_id, earliest_seq, body) VALUES (?, ?, ?)').run(room.roomId, record.earliestSeq, JSON.stringify(room));
                    continue;
                }
                if (!room) {
                    throw refuse('it does not start with the room');
                }
                switch (record.kind) {
                    case 'participant':
                        ours(record.participant.roomId);
                        participants.add(record.participant.participantId);
                        this.db.prepare('INSERT INTO participants (participant_id, room_id, credential_hash, body) VALUES (?, ?, ?, ?)').run(record.participant.participantId, room.roomId, record.participant.credentialHash, JSON.stringify(record.participant));
                        break;
                    case 'handover':
                        ours(record.handover.roomId);
                        this.db.prepare('INSERT INTO handovers (handover_id, room_id, body) VALUES (?, ?, ?)').run(record.handover.handoverId, room.roomId, JSON.stringify(record.handover));
                        break;
                    case 'control':
                        ours(record.control.roomId);
                        this.db.prepare('INSERT INTO controls (room_id, target_participant_id, body) VALUES (?, ?, ?)').run(room.roomId, record.control.targetParticipantId, JSON.stringify(record.control));
                        break;
                    case 'event':
                        ours(record.event.roomId);
                        if (record.event.seq !== nextSeq) {
                            throw refuse(`event ${record.event.seq} arrived where ${nextSeq} was expected`);
                        }
                        if (record.event.senderId !== null && !participants.has(record.event.senderId)) {
                            throw refuse('an event comes from someone who is not in the room');
                        }
                        this.writeEvent(record.event);
                        nextSeq++;
                        events++;
                        break;
                    case 'request':
                        this.db.prepare('INSERT INTO message_requests(event_id,room_id,seq,received_at,response_event_id,requires_reply,body) VALUES(?,?,?,?,?,?,?)').run(record.request.eventId, room.roomId, record.request.seq, record.request.receivedAt, record.request.responseEventId, record.request.requiresReply ? 1 : 0, JSON.stringify(record.request.body));
                        break;
                    case 'receipt-range':
                        this.db.prepare('INSERT INTO receipt_ranges(room_id,participant_id,through_seq,at) VALUES(?,?,?,?)').run(room.roomId, record.participantId, record.throughSeq, record.at);
                        break;
                    case 'idempotency':
                        this.db.prepare('INSERT INTO idempotency (room_id, key, request_digest, seq) VALUES (?, ?, ?, ?)').run(room.roomId, record.key, record.requestDigest, record.seq);
                        break;
                    case 'file':
                        ours(record.file.roomId);
                        fileSizes.set(record.file.fileId, {size: record.file.size, written: 0, chunks: 0});
                        this.db.prepare('INSERT INTO files (file_id, room_id, size, created_at, event_id, body) VALUES (?, ?, ?, ?, ?, ?)').run(record.file.fileId, room.roomId, record.file.size, record.file.createdAt, record.file.eventId, JSON.stringify(record.file));
                        break;
                    case 'file-chunk': {
                        const file = fileSizes.get(record.fileId);
                        const bytes = fromBase64(record.bytes);
                        if (!file || record.index !== file.chunks || file.written + bytes.byteLength > file.size) {
                            throw refuse('file content arrived out of order');
                        }
                        this.db.prepare('INSERT INTO file_chunks (file_id, idx, bytes) VALUES (?, ?, ?)').run(record.fileId, record.index, bytes);
                        file!.written += bytes.byteLength;
                        file!.chunks++;
                        break;
                    }
                    case 'complete':
                        complete = record;
                        break;
                }
            }
            if (!room || !complete) {
                throw refuse('the transfer did not finish');
            }
            if (nextSeq !== room.nextSeq || complete.events !== events || complete.files !== fileSizes.size) {
                throw refuse('some events or files are missing');
            }
            if ([...fileSizes.values()].some((file) => file.written !== file.size)) {
                throw refuse('a file arrived incomplete');
            }
            return {roomId: room.roomId, events, files: fileSizes.size};
        });
    }

    private writeParticipant(participant: ParticipantRecord): void {
        this.db
            .prepare(
                'INSERT INTO participants (participant_id, room_id, credential_hash, body) VALUES (?, ?, ?, ?) ON CONFLICT (participant_id) DO UPDATE SET body = excluded.body'
            )
            .run(participant.participantId, participant.roomId, participant.credentialHash, JSON.stringify(participant));
    }

    private writeEvent(event: RoomEvent): void {
        this.db.prepare('INSERT INTO events (room_id, seq, body) VALUES (?, ?, ?)').run(event.roomId, event.seq, JSON.stringify(event));
    }

    private rows<T>(sql: string, roomId: string): T[] {
        return (this.db.prepare(sql).all(roomId) as unknown as BodyRow[]).map((row) => JSON.parse(row.body) as T);
    }
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

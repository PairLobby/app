//! A `RoomStore` on `node:sqlite`. Every mutation lands inside one immediate
//! transaction: the JavaScript event loop is not a substitute for SQL isolation
//! once two requests interleave around an await.

import {ProtocolError} from '@pairlobby/protocol';
import {SCHEMA} from './schema';

import type {HandoverRecord, MessageRequest, RequestPage, InviteRecord, ParticipantRecord, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import type {Mutation, RoomView} from '@pairlobby/room-core';
import {REQUEST_BACKFILL_SQL} from '@pairlobby/server-core';
import type {EventPage, IdempotencyRecord, RoomStore} from '@pairlobby/server-core';

type IdempotencyKey = {key: string; requestDigest: string} | null;

interface BodyRow {
    body: string;
}

export class HostedRoomStore implements RoomStore {
    private readonly db: SqlDriver;
    constructor(
        private readonly storage: DurableObjectStorage,
        private readonly beforeApply: (mutation: Mutation) => void = () => {}
    ) {
        this.db = new SqlDriver(storage.sql);
        this.db.exec(SCHEMA);
        if (!this.db.prepare("SELECT value FROM meta WHERE key='message_requests_v1'").get()) {
            this.transaction(() => this.db.exec(REQUEST_BACKFILL_SQL));
        }
    }
    private transaction<T>(run: () => T): T {
        return this.storage.transactionSync(run);
    }

    async createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void> {
        this.transaction(() => {
            this.beforeApply({room, appendEvent: event, upsertParticipants: [], upsertHandovers: [], upsertControls: []});
            this.db.prepare('INSERT INTO rooms (room_id, earliest_seq, body) VALUES (?, 1, ?)').run(room.roomId, JSON.stringify(room));
            this.writeParticipant(participant);
            this.writeEvent(event);
        });
    }

    async loadRoom(roomId: string): Promise<RoomView | null> {
        const row = this.db.prepare('SELECT earliest_seq, body FROM rooms WHERE room_id = ?').get(roomId) as {earliest_seq: number; body: string} | undefined;
        if (!row) {
            return null;
        }
        return {
            room: JSON.parse(row.body) as RoomRecord,
            participants: this.rows('SELECT body FROM participants WHERE room_id = ? ORDER BY participant_id', roomId),
            handovers: this.rows('SELECT body FROM handovers WHERE room_id = ? ORDER BY handover_id', roomId),
            controls: this.rows('SELECT body FROM controls WHERE room_id = ? ORDER BY target_participant_id', roomId),
            earliestSeq: row.earliest_seq
        };
    }

    async apply(mutation: Mutation, idempotency: IdempotencyKey): Promise<void> {
        this.transaction(() => {
            const current = this.db.prepare('SELECT body FROM rooms WHERE room_id = ?').get(mutation.room.roomId) as BodyRow | undefined;
            if (!current || JSON.parse(current.body).nextSeq !== mutation.appendEvent.seq) {
                throw new ProtocolError('server_unavailable', 'concurrent room mutation; retry with the same idempotency key');
            }
            this.beforeApply(mutation);
            this.db.prepare('UPDATE rooms SET body = ? WHERE room_id = ?').run(JSON.stringify(mutation.room), mutation.room.roomId);
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
            this.writeEvent(mutation.appendEvent);
            if (idempotency) {
                this.db
                    .prepare('INSERT INTO idempotency (room_id, key, request_digest, seq) VALUES (?, ?, ?, ?)')
                    .run(mutation.room.roomId, idempotency.key, idempotency.requestDigest, mutation.appendEvent.seq);
            }
        });
    }

    async readEvents(roomId: string, after: number, limit: number): Promise<EventPage> {
        const pageLimit = Math.min(limit, 100);
        const rows = this.db.prepare('SELECT body FROM events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(roomId, after, pageLimit + 1) as unknown as BodyRow[];
        const events: RoomEvent[] = [];
        let bytes = 0;
        for (const row of rows.slice(0, pageLimit)) {
            const size = new TextEncoder().encode(row.body).byteLength;
            if (events.length && bytes + size > 256 * 1024) {
                break;
            }
            events.push(JSON.parse(row.body) as RoomEvent);
            bytes += size;
        }
        return {events, hasMore: rows.length > events.length};
    }

    async eventBySeq(roomId: string, seq: number): Promise<RoomEvent | null> {
        const row = this.db.prepare('SELECT body FROM events WHERE room_id = ? AND seq = ?').get(roomId, seq) as BodyRow | undefined;
        return row ? (JSON.parse(row.body) as RoomEvent) : null;
    }

    async eventById(roomId: string, eventId: string): Promise<RoomEvent | null> {
        const row = this.db.prepare("SELECT body FROM events WHERE room_id = ? AND json_extract(body, '$.eventId') = ?").get(roomId, eventId) as BodyRow | undefined;
        return row ? (JSON.parse(row.body) as RoomEvent) : null;
    }

    async idempotencyRecord(roomId: string, key: string): Promise<IdempotencyRecord | null> {
        const row = this.db.prepare('SELECT request_digest, seq FROM idempotency WHERE room_id = ? AND key = ?').get(roomId, key) as
            | {request_digest: string; seq: number}
            | undefined;
        return row ? {requestDigest: row.request_digest, seq: row.seq} : null;
    }

    async putInvite(invite: InviteRecord): Promise<void> {
        this.db
            .prepare('INSERT INTO invites (digest, room_id, state, bound_attempt_id, body) VALUES (?, ?, ?, ?, ?)')
            .run(invite.digest, invite.roomId, invite.state, invite.boundAttemptId, JSON.stringify(invite));
    }

    async inviteByDigest(digest: string): Promise<InviteRecord | null> {
        const row = this.db.prepare('SELECT body FROM invites WHERE digest = ?').get(digest) as BodyRow | undefined;
        return row ? (JSON.parse(row.body) as InviteRecord) : null;
    }

    /**
     * The conditional UPDATE is the whole point: a second attempt matches no row
     * and gets null, rather than racing the first into membership creation.
     */
    async reserveInvite(digest: string, attemptId: string, credentialHash: string, expectedOccupantId: string | null): Promise<InviteRecord | null> {
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
            return result.changes === 1 ? reserved : null;
        });
    }

    async completeInvite(digest: string, participantId: string): Promise<void> {
        this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM invites WHERE digest = ?').get(digest) as BodyRow | undefined;
            if (!row) {
                return;
            }
            const invite = {...(JSON.parse(row.body) as InviteRecord), state: 'redeemed' as const, redeemedParticipantId: participantId};
            this.db.prepare("UPDATE invites SET state = 'redeemed', body = ? WHERE digest = ?").run(JSON.stringify(invite), digest);
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
        const row = this.db.prepare('SELECT body FROM message_requests WHERE room_id=? AND event_id=?').get(roomId, eventId) as BodyRow | undefined;
        return row ? (JSON.parse(row.body) as MessageRequest) : null;
    }
    async messageRequests(roomId: string, after: number, limit: number, recipientId?: string): Promise<RequestPage> {
        const rows = this.db
            .prepare(
                "SELECT body FROM message_requests WHERE room_id=? AND seq>? AND requires_reply=1 AND response_event_id IS NULL AND (? IS NULL OR json_extract(body,'$.to')=?) ORDER BY seq LIMIT ?"
            )
            .all(roomId, after, recipientId ?? null, recipientId ?? null, limit + 1) as unknown as BodyRow[];
        return {requests: rows.slice(0, limit).map((row) => JSON.parse(row.body) as MessageRequest), hasMore: rows.length > limit};
    }
    private writeRequest(request: MessageRequest): void {
        // Keep concurrent receipt/progress writes from erasing an accepted reply.
        const old = this.db.prepare('SELECT body FROM message_requests WHERE event_id=?').get(request.eventId) as BodyRow | undefined;
        const previous = old ? (JSON.parse(old.body) as MessageRequest) : null;
        const merged = {
            ...request,
            receivedAt: previous?.receivedAt ?? request.receivedAt,
            responseEventId: previous?.responseEventId ?? request.responseEventId,
            respondedAt: previous?.respondedAt ?? request.respondedAt,
            progressAt: Math.max(previous?.progressAt ?? 0, request.progressAt ?? 0) || null
        };
        this.db
            .prepare(
                'INSERT INTO message_requests(event_id,room_id,seq,received_at,response_event_id,requires_reply,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET received_at=excluded.received_at,response_event_id=excluded.response_event_id,body=excluded.body'
            )
            .run(merged.eventId, merged.roomId, merged.seq, merged.receivedAt, merged.responseEventId, merged.requiresReply ? 1 : 0, JSON.stringify(merged));
    }

    async setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle']): Promise<void> {
        this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM rooms WHERE room_id = ?').get(roomId) as BodyRow | undefined;
            if (!row) {
                return;
            }
            const room = {...(JSON.parse(row.body) as RoomRecord), lifecycle};
            this.db.prepare('UPDATE rooms SET body = ? WHERE room_id = ?').run(JSON.stringify(room), roomId);
        });
    }

    /** Physical cleanup. Access was already denied by the lifecycle change. */
    async deleteRoom(roomId: string): Promise<void> {
        this.transaction(() => {
            for (const table of ['message_requests', 'events', 'idempotency', 'handovers', 'controls', 'invites', 'participants']) {
                this.db.prepare(`DELETE FROM ${table} WHERE room_id = ?`).run(roomId);
            }
        });
    }

    /** Simulates retention dropping the front of the log without touching room state. */
    dropHistoryBefore(roomId: string, seq: number): void {
        this.transaction(() => {
            this.db.prepare('DELETE FROM events WHERE room_id = ? AND seq < ?').run(roomId, seq);
            this.db.prepare('UPDATE rooms SET earliest_seq = ? WHERE room_id = ?').run(seq, roomId);
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

// Synchronous driver keeps the shared SQLite statements and transaction boundaries
// aligned with the local adapter while using Durable Object SQL in production.
class SqlDriver {
    constructor(private sql: SqlStorage) {}
    exec(query: string) {
        this.sql.exec(query);
    }
    prepare(query: string) {
        const sql = this.sql;
        return {
            run(...values: (string | number | null)[]) {
                const result = sql.exec(query, ...values);
                return {changes: Number(sql.exec('SELECT changes() AS n').one().n)};
            },
            get(...values: (string | number | null)[]) {
                return sql.exec(query, ...values).toArray()[0];
            },
            all(...values: (string | number | null)[]) {
                return sql.exec(query, ...values).toArray();
            }
        };
    }
}

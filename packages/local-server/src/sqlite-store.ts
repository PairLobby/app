//! A `RoomStore` on `node:sqlite`. Every mutation lands inside one immediate
//! transaction: the JavaScript event loop is not a substitute for SQL isolation
//! once two requests interleave around an await.

import {DatabaseSync} from 'node:sqlite';

import type {HandoverRecord, InviteRecord, ParticipantRecord, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import type {Mutation, RoomView} from '@pairlobby/room-core';
import type {EventPage, IdempotencyRecord, RoomStore} from '@pairlobby/server-core';

import {SCHEMA, SCHEMA_VERSION} from './schema.js';

interface BodyRow {
    body: string;
}

export class SqliteRoomStore implements RoomStore {
    private readonly db: DatabaseSync;

    constructor(location: string) {
        this.db = new DatabaseSync(location);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec('PRAGMA busy_timeout = 5000');
        this.db.exec(SCHEMA);
        this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run('schema_version', String(SCHEMA_VERSION));
    }

    close(): void {
        this.db.close();
    }

    private transaction<T>(run: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = run();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    async createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void> {
        this.transaction(() => {
            this.db.prepare('INSERT INTO rooms (room_id, earliest_seq, body) VALUES (?, 1, ?)').run(room.roomId, JSON.stringify(room));
            this.writeParticipant(participant);
            this.writeEvent(event);
        });
    }

    async loadRoom(roomId: string): Promise<RoomView | null> {
        const row = this.db.prepare('SELECT earliest_seq, body FROM rooms WHERE room_id = ?').get(roomId) as {earliest_seq: number; body: string} | undefined;
        if (!row) return null;
        return {
            room: JSON.parse(row.body) as RoomRecord,
            participants: this.rows('SELECT body FROM participants WHERE room_id = ? ORDER BY participant_id', roomId),
            handovers: this.rows('SELECT body FROM handovers WHERE room_id = ? ORDER BY handover_id', roomId),
            controls: this.rows('SELECT body FROM controls WHERE room_id = ? ORDER BY target_participant_id', roomId),
            earliestSeq: row.earliest_seq,
        };
    }

    async apply(mutation: Mutation, idempotency: {key: string; requestDigest: string} | null): Promise<void> {
        this.transaction(() => {
            this.db.prepare('UPDATE rooms SET body = ? WHERE room_id = ?').run(JSON.stringify(mutation.room), mutation.room.roomId);
            for (const participant of mutation.upsertParticipants) this.writeParticipant(participant);
            for (const handover of mutation.upsertHandovers) {
                this.db.prepare('INSERT INTO handovers (handover_id, room_id, body) VALUES (?, ?, ?) ON CONFLICT (handover_id) DO UPDATE SET body = excluded.body').run(handover.handoverId, handover.roomId, JSON.stringify(handover));
            }
            for (const control of mutation.upsertControls) {
                this.db.prepare('INSERT INTO controls (room_id, target_participant_id, body) VALUES (?, ?, ?) ON CONFLICT (room_id, target_participant_id) DO UPDATE SET body = excluded.body').run(control.roomId, control.targetParticipantId, JSON.stringify(control));
            }
            this.writeEvent(mutation.appendEvent);
            if (idempotency) {
                this.db.prepare('INSERT INTO idempotency (room_id, key, request_digest, seq) VALUES (?, ?, ?, ?)').run(mutation.room.roomId, idempotency.key, idempotency.requestDigest, mutation.appendEvent.seq);
            }
        });
    }

    async readEvents(roomId: string, after: number, limit: number): Promise<EventPage> {
        const rows = this.db.prepare('SELECT body FROM events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(roomId, after, limit + 1) as unknown as BodyRow[];
        const events = rows.slice(0, limit).map((row) => JSON.parse(row.body) as RoomEvent);
        return {events, hasMore: rows.length > limit};
    }

    async eventBySeq(roomId: string, seq: number): Promise<RoomEvent | null> {
        const row = this.db.prepare('SELECT body FROM events WHERE room_id = ? AND seq = ?').get(roomId, seq) as BodyRow | undefined;
        return row ? (JSON.parse(row.body) as RoomEvent) : null;
    }

    async idempotencyRecord(roomId: string, key: string): Promise<IdempotencyRecord | null> {
        const row = this.db.prepare('SELECT request_digest, seq FROM idempotency WHERE room_id = ? AND key = ?').get(roomId, key) as {request_digest: string; seq: number} | undefined;
        return row ? {requestDigest: row.request_digest, seq: row.seq} : null;
    }

    async putInvite(invite: InviteRecord): Promise<void> {
        this.db.prepare('INSERT INTO invites (digest, room_id, state, bound_attempt_id, body) VALUES (?, ?, ?, ?, ?)').run(invite.digest, invite.roomId, invite.state, invite.boundAttemptId, JSON.stringify(invite));
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
            if (!row) return null;
            const invite = JSON.parse(row.body) as InviteRecord;
            if (invite.boundAttemptId === attemptId) return invite;
            if (invite.state === 'reserved') return null;
            if (invite.state === 'redeemed') {
                if (!invite.reusable) return null;
                if (invite.redeemedParticipantId !== expectedOccupantId) return null;
            } else if (expectedOccupantId !== null) {
                return null;
            }
            const reserved: InviteRecord = {...invite, state: 'reserved', boundAttemptId: attemptId, boundCredentialHash: credentialHash};
            // The WHERE clause repeats the precondition so a concurrent writer that
            // slipped in between the read and this update loses rather than overwrites.
            const previous = invite.state === 'redeemed' ? invite.redeemedParticipantId : null;
            const result = previous === null
                ? this.db.prepare("UPDATE invites SET state = 'reserved', bound_attempt_id = ?, body = ? WHERE digest = ? AND state = 'unused'").run(attemptId, JSON.stringify(reserved), digest)
                : this.db.prepare("UPDATE invites SET state = 'reserved', bound_attempt_id = ?, body = ? WHERE digest = ? AND state = 'redeemed' AND json_extract(body, '$.redeemedParticipantId') = ?").run(attemptId, JSON.stringify(reserved), digest, previous);
            return result.changes === 1 ? reserved : null;
        });
    }

    async completeInvite(digest: string, participantId: string): Promise<void> {
        this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM invites WHERE digest = ?').get(digest) as BodyRow | undefined;
            if (!row) return;
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

    async setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle']): Promise<void> {
        this.transaction(() => {
            const row = this.db.prepare('SELECT body FROM rooms WHERE room_id = ?').get(roomId) as BodyRow | undefined;
            if (!row) return;
            const room = {...(JSON.parse(row.body) as RoomRecord), lifecycle};
            this.db.prepare('UPDATE rooms SET body = ? WHERE room_id = ?').run(JSON.stringify(room), roomId);
        });
    }

    /** Physical cleanup. Access was already denied by the lifecycle change. */
    async deleteRoom(roomId: string): Promise<void> {
        this.transaction(() => {
            for (const table of ['events', 'idempotency', 'handovers', 'controls', 'invites', 'participants']) {
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
        this.db.prepare('INSERT INTO participants (participant_id, room_id, credential_hash, body) VALUES (?, ?, ?, ?) ON CONFLICT (participant_id) DO UPDATE SET body = excluded.body').run(participant.participantId, participant.roomId, participant.credentialHash, JSON.stringify(participant));
    }

    private writeEvent(event: RoomEvent): void {
        this.db.prepare('INSERT INTO events (room_id, seq, body) VALUES (?, ?, ?)').run(event.roomId, event.seq, JSON.stringify(event));
    }

    private rows<T>(sql: string, roomId: string): T[] {
        return (this.db.prepare(sql).all(roomId) as unknown as BodyRow[]).map((row) => JSON.parse(row.body) as T);
    }
}

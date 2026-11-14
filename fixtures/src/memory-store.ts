//! An in-memory `RoomStore`. It is the reference the SQLite and Durable Object
//! stores are measured against, and it is deliberately strict: `apply` either
//! lands every part of a mutation or throws before touching anything.

import {FILE_CHUNK_BYTES, ProtocolError, mergeMessageRequest} from '@pairlobby/protocol';
import type {FileRecord, HandoverRecord, MessageRequest, RequestPage, InviteRecord, ParticipantRecord, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import type {Mutation, RoomView} from '@pairlobby/room-core';
import type {EventPage, FileStore, IdempotencyRecord, RoomHead, RoomLoadOptions, RoomStore} from '@pairlobby/server-core';
import {committedRoom, mutationChanges, eventPage, requestPage} from '@pairlobby/server-core';

type IdempotencyKey = {key: string; requestDigest: string} | null;
type StoredFile = {file: FileRecord; bytes: Uint8Array};
type StagedFile = {file: FileRecord; chunks: Uint8Array[]; received: number};
type ReceiptRange = {throughSeq: number; at: number};

interface RoomTable {
    room: RoomRecord;
    participants: ParticipantRecord[];
    handovers: HandoverRecord[];
    controls: RoomView['controls'];
    events: RoomEvent[];
    idempotency: Map<string, IdempotencyRecord>;
    earliestSeq: number;
}

export class MemoryStore implements RoomStore {
    private rooms = new Map<string, RoomTable>();
    private requests = new Map<string, MessageRequest>();
    private invites = new Map<string, InviteRecord>();
    private stored = new Map<string, StoredFile>();
    private uploads = new Map<string, StagedFile>();
    private receiptRanges = new Map<string, ReceiptRange[]>();
    readonly files: FileStore = {
        retention: {
            update: async (file, expectedStateRevision) => {
                const entry = this.inRoom(file.roomId, file.fileId);
                if (!entry) {
                    throw new ProtocolError('turn_conflict', 'the file changed; retry');
                }
                this.bumpFileState(file.roomId, expectedStateRevision);
                entry.file = file;
            },
            remove: async (roomId, fileId, expectedStateRevision) => {
                this.bumpFileState(roomId, expectedStateRevision);
                if (this.stored.get(fileId)?.file.roomId === roomId) {
                    this.stored.delete(fileId);
                }
                if (this.uploads.get(fileId)?.file.roomId === roomId) {
                    this.uploads.delete(fileId);
                }
            },
            due: async (now, limit) => [...this.stored.values(), ...this.uploads.values()].map((entry) => entry.file).filter((file) => file.retention?.mode === 'temporary' && file.retention.expiresAt <= now).sort((a, b) => (a.retention?.mode === 'temporary' ? a.retention.expiresAt : 0) - (b.retention?.mode === 'temporary' ? b.retention.expiresAt : 0)).slice(0, limit),
            nextExpiryAt: async () => {
                const deadlines = [...this.stored.values(), ...this.uploads.values()].flatMap((entry) => entry.file.retention?.mode === 'temporary' ? [entry.file.retention.expiresAt] : []);
                return deadlines.length ? Math.min(...deadlines) : null;
            }
        },
        putFile: async (file, bytes, limitBytes, expectedStateRevision) => {
            const held = this.fileUsage(file.roomId);
            if (held + file.size > limitBytes) {
                return false;
            }
            this.bumpFileState(file.roomId, expectedStateRevision);
            this.stored.set(file.fileId, {file, bytes: bytes.slice()});
            return true;
        },
        createUpload: async (file, limitBytes, expectedStateRevision) => {
            if (this.fileUsage(file.roomId) + file.size > limitBytes) {
                return false;
            }
            this.bumpFileState(file.roomId, expectedStateRevision);
            this.uploads.set(file.fileId, {file, chunks: [], received: 0});
            return true;
        },
        writeChunk: async (roomId, fileId, index, bytes) => {
            const entry = this.uploads.get(fileId);
            if (!entry || entry.file.roomId !== roomId || entry.chunks.length !== index || bytes.byteLength > FILE_CHUNK_BYTES || entry.received + bytes.byteLength > entry.file.size) {
                throw new ProtocolError('invalid_request', 'the upload is no longer available or its chunks are out of order');
            }
            entry.chunks.push(bytes.slice());
            entry.received += bytes.byteLength;
        },
        completeUpload: async (file, expectedStateRevision) => {
            const entry = this.uploads.get(file.fileId);
            if (!entry || entry.file.roomId !== file.roomId || entry.received !== file.size || entry.file.size !== file.size) {
                throw new ProtocolError('invalid_request', 'the upload did not finish');
            }
            this.bumpFileState(file.roomId, expectedStateRevision);
            const bytes = new Uint8Array(file.size);
            let offset = 0;
            for (const chunk of entry.chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            this.stored.set(file.fileId, {file, bytes});
            this.uploads.delete(file.fileId);
        },
        cancelUpload: async (roomId, fileId) => {
            if (this.uploads.get(fileId)?.file.roomId === roomId) {
                this.uploads.delete(fileId);
                this.bumpFileState(roomId);
            }
        },
        fileStream: async (roomId, fileId) => {
            const file = this.inRoom(roomId, fileId);
            let offset = 0;
            return file ? new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (offset >= file.bytes.byteLength) {
                        controller.close();
                    } else {
                        controller.enqueue(file.bytes.slice(offset, offset + FILE_CHUNK_BYTES));
                        offset += FILE_CHUNK_BYTES;
                    }
                }
            }, {highWaterMark: 0}) : null;
        },
        file: async (roomId, fileId) => this.inRoom(roomId, fileId)?.file ?? null,
        fileBytes: async (roomId, fileId) => this.inRoom(roomId, fileId)?.bytes.slice() ?? null,
        attachedFiles: async (roomId) => [...this.stored.values()].map((entry) => entry.file).filter((file) => file.roomId === roomId && file.eventId !== null).sort((a, b) => a.createdAt - b.createdAt || a.fileId.localeCompare(b.fileId)),
        usedBytes: async (roomId) => this.fileUsage(roomId),
        deleteUnattachedFiles: async (roomId, before) => {
            let changed = false;
            for (const [fileId, {file}] of this.stored) {
                if (file.roomId === roomId && file.eventId === null && file.createdAt < before) {
                    this.stored.delete(fileId);
                    changed = true;
                }
            }
            for (const [fileId, {file}] of this.uploads) {
                if (file.roomId === roomId && file.createdAt < before) {
                    this.uploads.delete(fileId);
                    changed = true;
                }
            }
            if (changed) {
                this.bumpFileState(roomId);
            }
        },
    };

    private fileUsage(roomId: string): number {
        return [...this.stored.values(), ...this.uploads.values()].filter((entry) => entry.file.roomId === roomId).reduce((total, entry) => total + entry.file.size, 0);
    }

    private bumpFileState(roomId: string, expectedStateRevision?: number): void {
        const table = this.require(roomId);
        table.room = committedRoom(table.room, {...table.room, stateRevision: expectedStateRevision ?? table.room.stateRevision ?? 0});
    }

    private inRoom(roomId: string, fileId: string): StoredFile | undefined {
        const entry = this.stored.get(fileId);
        return entry?.file.roomId === roomId ? entry : undefined;
    }

    async createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void> {
        this.rooms.set(room.roomId, {room, participants: [participant], handovers: [], controls: [], events: [event], idempotency: new Map(), earliestSeq: 1});
    }

    async roomHead(roomId: string): Promise<RoomHead | null> {
        const table = this.rooms.get(roomId);
        return table ? {room: table.room, earliestSeq: table.earliestSeq} : null;
    }

    async loadRoom(roomId: string, options: RoomLoadOptions = {}): Promise<RoomView | null> {
        const table = this.rooms.get(roomId);
        if (!table) {
            return null;
        }
        return {room: table.room, participants: table.participants, handovers: options.handovers === false ? [] : table.handovers, controls: table.controls, earliestSeq: table.earliestSeq};
    }

    async apply(mutation: Mutation, idempotency: IdempotencyKey): Promise<void> {
        const table = this.require(mutation.room.roomId);
        if (mutation.expectedTurnRevision !== undefined && (table.room.turnRevision ?? 0) !== mutation.expectedTurnRevision) {
            throw new ProtocolError('turn_conflict', 'the room turn changed; retry');
        }
        if (table.room.nextSeq !== mutation.appendEvent.seq) {
            throw new ProtocolError('turn_conflict', 'concurrent room mutation; retry with the same idempotency key');
        }
        const changes = mutationChanges(mutation);
        const room = committedRoom(table.room, mutation.room, {...changes, requests: changes.requests || this.receiptsChangeRequests(table.room, mutation.room)});
        const attaching = (mutation.attachFiles ?? []).map((fileId) => this.inRoom(mutation.room.roomId, fileId));
        if (attaching.some((entry) => !entry || entry.file.eventId !== null)) {
            throw new ProtocolError('invalid_request', 'an attached file is no longer available; upload it again');
        }
        for (const entry of attaching) {
            entry!.file = mutation.attachedFileRecords?.find((file) => file.fileId === entry!.file.fileId) ?? {...entry!.file, eventId: mutation.appendEvent.eventId};
        }
        for (const fileId of mutation.removeFiles ?? []) {
            if (this.stored.get(fileId)?.file.roomId === mutation.room.roomId) {
                this.stored.delete(fileId);
            }
        }
        this.writeReceipts(table.room, room);
        table.room = room;
        for (const participant of mutation.upsertParticipants) table.participants = upsert(table.participants, participant, 'participantId');
        for (const handover of mutation.upsertHandovers) table.handovers = upsert(table.handovers, handover, 'handoverId');
        for (const control of mutation.upsertControls) table.controls = upsert(table.controls, control, 'targetParticipantId');
        for (const request of mutation.upsertRequests ?? []) {
            const previous = this.requests.get(request.eventId);
            this.requests.set(request.eventId, mergeMessageRequest(previous ? this.received(previous) : null, request));
        }
        table.events.push(mutation.appendEvent);
        if (idempotency) {
            table.idempotency.set(idempotency.key, {requestDigest: idempotency.requestDigest, seq: mutation.appendEvent.seq});
        }
    }

    async readEvents(roomId: string, after: number, limit: number, through = Number.MAX_SAFE_INTEGER): Promise<EventPage> {
        const table = this.require(roomId);
        const matching = table.events.filter((event) => event.seq > after && event.seq <= through);
        return eventPage(matching.map((event) => ({body: JSON.stringify(event)})), limit);
    }

    async eventBySeq(roomId: string, seq: number): Promise<RoomEvent | null> {
        return this.require(roomId).events.find((event) => event.seq === seq) ?? null;
    }

    async eventById(roomId: string, eventId: string): Promise<RoomEvent | null> {
        return this.require(roomId).events.find((event) => event.eventId === eventId) ?? null;
    }

    async idempotencyRecord(roomId: string, key: string): Promise<IdempotencyRecord | null> {
        return this.require(roomId).idempotency.get(key) ?? null;
    }

    async putInvite(invite: InviteRecord, expectedStateRevision?: number): Promise<void> {
        this.bumpRoom(invite.roomId, expectedStateRevision);
        this.invites.set(invite.digest, invite);
    }

    async inviteByDigest(digest: string): Promise<InviteRecord | null> {
        return this.invites.get(digest) ?? null;
    }

    async reserveInvite(digest: string, attemptId: string, credentialHash: string, expectedOccupantId: string | null, expectedStateRevision?: number): Promise<InviteRecord | null> {
        const invite = this.invites.get(digest);
        if (!invite) {
            return null;
        }
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
        this.bumpRoom(invite.roomId, expectedStateRevision);
        this.invites.set(digest, reserved);
        return reserved;
    }

    async completeInvite(digest: string, participantId: string, attemptId?: string): Promise<void> {
        const invite = this.invites.get(digest);
        if (!invite) {
            return;
        }
        if (attemptId !== undefined && invite.boundAttemptId !== attemptId) {
            throw new ProtocolError('invite_already_redeemed', 'this invite belongs to another redemption attempt');
        }
        if (invite.state === 'redeemed' && invite.redeemedParticipantId === participantId) {
            return;
        }
        this.bumpRoom(invite.roomId);
        this.invites.set(digest, {...invite, state: 'redeemed', redeemedParticipantId: participantId});
    }

    async participantByCredential(roomId: string, credentialHash: string): Promise<ParticipantRecord | null> {
        return this.require(roomId).participants.find((participant) => participant.credentialHash === credentialHash) ?? null;
    }

    async handovers(roomId: string): Promise<HandoverRecord[]> {
        return [...this.require(roomId).handovers];
    }

    async messageRequest(roomId: string, eventId: string): Promise<MessageRequest | null> {
        const value = this.requests.get(eventId);
        return value?.roomId === roomId ? this.received(value) : null;
    }
    async groupRequests(roomId: string, conversationId: string): Promise<MessageRequest[]> {
        return [...this.requests.values()].filter((request) => request.roomId === roomId && request.conversationId === conversationId).sort((a, b) => a.seq - b.seq).map((request) => this.received(request));
    }

    async updateTurns(room: RoomRecord, requests: MessageRequest[], expectedRevision: number): Promise<void> {
        const table = this.require(room.roomId);
        if ((table.room.turnRevision ?? 0) !== expectedRevision || table.room.nextSeq !== room.nextSeq) {
            throw new ProtocolError('turn_conflict', 'the room turn changed; retry');
        }
        const committed = committedRoom(table.room, room, {requests: requests.length > 0 || this.receiptsChangeRequests(table.room, room)});
        this.writeReceipts(table.room, committed);
        table.room = committed;
        for (const request of requests) {
            const previous = this.requests.get(request.eventId);
            this.requests.set(request.eventId, mergeMessageRequest(previous ? this.received(previous) : null, request));
        }
    }

    async messageRequests(roomId: string, after: number, limit: number, recipientId?: string): Promise<RequestPage> {
        const records = [...this.requests.values()]
            .filter((r) => r.roomId === roomId && r.seq > after && r.requiresReply && !r.responseEventId && (!recipientId || r.to === recipientId))
            .sort((a, b) => a.seq - b.seq);
        return requestPage(records.map((request) => ({body: JSON.stringify(this.received(request))})), limit);
    }

    async unreceivedRequests(roomId: string, recipientId: string, after: number, limit: number): Promise<RequestPage> {
        const records = [...this.requests.values()].map((request) => this.received(request)).filter((request) => request.roomId === roomId && request.to === recipientId && request.seq > after && request.receivedAt === null).sort((a, b) => a.seq - b.seq);
        return requestPage(records.map((request) => ({body: JSON.stringify(request)})), limit);
    }

    async pendingRequestCount(roomId: string): Promise<number> {
        return [...this.requests.values()].filter((request) => request.roomId === roomId && request.requiresReply && request.responseEventId === null).length;
    }

    private writeReceipts(previous: RoomRecord, room: RoomRecord): void {
        for (const [participantId, mark] of Object.entries(room.receipts ?? {})) {
            if (mark.throughSeq > (previous.receipts?.[participantId]?.throughSeq ?? 0)) {
                const key = `${room.roomId}:${participantId}`;
                const ranges = this.receiptRanges.get(key) ?? [];
                ranges.push({throughSeq: mark.throughSeq, at: mark.at});
                this.receiptRanges.set(key, ranges);
            }
        }
    }

    private receiptsChangeRequests(previous: RoomRecord, room: RoomRecord): boolean {
        return [...this.requests.values()].some((request) => request.roomId === room.roomId && request.requiresReply && !request.responseEventId && this.received(request).receivedAt === null && (room.receipts?.[request.to]?.throughSeq ?? 0) > (previous.receipts?.[request.to]?.throughSeq ?? 0) && (request.messageSeq ?? 0) <= (room.receipts?.[request.to]?.throughSeq ?? 0));
    }

    private received(request: MessageRequest): MessageRequest {
        if (request.receivedAt !== null) {
            return request;
        }
        const seq = request.messageSeq ?? this.require(request.roomId).events.find((event) => event.eventId === (request.conversationId ?? request.eventId))?.seq ?? 0;
        const range = this.receiptRanges.get(`${request.roomId}:${request.to}`)?.find((mark) => mark.throughSeq >= seq);
        return range ? {...request, receivedAt: range.at} : request;
    }
    async setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle'], expectedStateRevision?: number): Promise<void> {
        const table = this.require(roomId);
        table.room = committedRoom(table.room, {...table.room, lifecycle, stateRevision: expectedStateRevision ?? table.room.stateRevision ?? 0}, {snapshot: true});
    }

    async deleteRoom(roomId: string): Promise<void> {
        const table = this.rooms.get(roomId);
        if (!table) {
            return;
        }
        for (const [id, request] of this.requests)
            if (request.roomId === roomId) {
                this.requests.delete(id);
            }
        for (const [fileId, {file}] of this.stored) {
            if (file.roomId === roomId) {
                this.stored.delete(fileId);
            }
        }
        for (const [fileId, {file}] of this.uploads) {
            if (file.roomId === roomId) {
                this.uploads.delete(fileId);
            }
        }
        table.events = [];
        table.handovers = [];
    }

    async dueAutoCloses(now: number, limit: number): Promise<string[]> {
        return this.deadlines(now).filter(([, at]) => at <= now).slice(0, limit).map(([roomId]) => roomId);
    }

    async nextAutoCloseAt(now = Date.now()): Promise<number | null> {
        return this.deadlines(now)[0]?.[1] ?? null;
    }

    private deadlines(now: number): [string, number][] {
        return [...this.rooms.values()]
            .filter((table) => table.room.lifecycle === 'open' && typeof table.room.autoCloseAt === 'number' && (table.room.expiresAt === null || table.room.expiresAt > now))
            .map((table): [string, number] => [table.room.roomId, table.room.autoCloseAt!])
            .sort((left, right) => left[1] - right[1]);
    }

    private bumpRoom(roomId: string, expectedStateRevision?: number): void {
        const table = this.require(roomId);
        table.room = committedRoom(table.room, {...table.room, stateRevision: expectedStateRevision ?? table.room.stateRevision ?? 0});
    }

    /** Simulates retention dropping the front of the log without touching room state. */
    dropHistoryBefore(roomId: string, seq: number): void {
        const table = this.require(roomId);
        table.events = table.events.filter((event) => event.seq >= seq);
        table.earliestSeq = seq;
    }

    private require(roomId: string): RoomTable {
        const table = this.rooms.get(roomId);
        if (!table) {
            throw new Error(`unknown room ${roomId}`);
        }
        return table;
    }
}

function upsert<T extends Record<string, unknown>>(list: T[], item: T, key: keyof T): T[] {
    const index = list.findIndex((candidate) => candidate[key] === item[key]);
    if (index === -1) {
        return [...list, item];
    }
    return list.map((candidate, position) => (position === index ? item : candidate));
}

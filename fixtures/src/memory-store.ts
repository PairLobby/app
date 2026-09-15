//! An in-memory `RoomStore`. It is the reference the SQLite and Durable Object
//! stores are measured against, and it is deliberately strict: `apply` either
//! lands every part of a mutation or throws before touching anything.

import type {HandoverRecord, MessageRequest, RequestPage, InviteRecord, ParticipantRecord, RoomEvent, RoomRecord} from '@pairlobby/protocol';
import type {Mutation, RoomView} from '@pairlobby/room-core';
import type {EventPage, IdempotencyRecord, RoomStore} from '@pairlobby/server-core';

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
    private requests = new Map<string,MessageRequest>();
    private invites = new Map<string, InviteRecord>();

    async createRoom(room: RoomRecord, participant: ParticipantRecord, event: RoomEvent): Promise<void> {
        this.rooms.set(room.roomId, {room, participants: [participant], handovers: [], controls: [], events: [event], idempotency: new Map(), earliestSeq: 1});
    }

    async loadRoom(roomId: string): Promise<RoomView | null> {
        const table = this.rooms.get(roomId);
        if (!table) return null;
        return {room: table.room, participants: table.participants, handovers: table.handovers, controls: table.controls, earliestSeq: table.earliestSeq};
    }

    async apply(mutation: Mutation, idempotency: {key: string; requestDigest: string} | null): Promise<void> {
        const table = this.require(mutation.room.roomId);
        table.room = mutation.room;
        for (const participant of mutation.upsertParticipants) table.participants = upsert(table.participants, participant, 'participantId');
        for (const handover of mutation.upsertHandovers) table.handovers = upsert(table.handovers, handover, 'handoverId');
        for (const control of mutation.upsertControls) table.controls = upsert(table.controls, control, 'targetParticipantId');
        for(const request of mutation.upsertRequests ?? []) {
            const previous=this.requests.get(request.eventId);
            this.requests.set(request.eventId,{...request,receivedAt:previous?.receivedAt ?? request.receivedAt,responseEventId:previous?.responseEventId ?? request.responseEventId,respondedAt:previous?.respondedAt ?? request.respondedAt,progressAt:Math.max(previous?.progressAt ?? 0,request.progressAt ?? 0)||null});
        }
        table.events.push(mutation.appendEvent);
        if (idempotency) table.idempotency.set(idempotency.key, {requestDigest: idempotency.requestDigest, seq: mutation.appendEvent.seq});
    }

    async readEvents(roomId: string, after: number, limit: number): Promise<EventPage> {
        const table = this.require(roomId);
        const matching = table.events.filter((event) => event.seq > after);
        const page = matching.slice(0, limit);
        return {events: page, hasMore: matching.length > page.length};
    }

    async eventBySeq(roomId: string, seq: number): Promise<RoomEvent | null> {
        return this.require(roomId).events.find((event) => event.seq === seq) ?? null;
    }

    async idempotencyRecord(roomId: string, key: string): Promise<IdempotencyRecord | null> {
        return this.require(roomId).idempotency.get(key) ?? null;
    }

    async putInvite(invite: InviteRecord): Promise<void> {
        this.invites.set(invite.digest, invite);
    }

    async inviteByDigest(digest: string): Promise<InviteRecord | null> {
        return this.invites.get(digest) ?? null;
    }

    async reserveInvite(digest: string, attemptId: string, credentialHash: string, expectedOccupantId: string | null): Promise<InviteRecord | null> {
        const invite = this.invites.get(digest);
        if (!invite) return null;
        if (invite.boundAttemptId === attemptId) return invite;
        if (invite.state === 'reserved') return null;
        if (invite.state === 'redeemed') {
            if (!invite.reusable) return null;
            if (invite.redeemedParticipantId !== expectedOccupantId) return null;
        } else if (expectedOccupantId !== null) {
            return null;
        }
        const reserved: InviteRecord = {...invite, state: 'reserved', boundAttemptId: attemptId, boundCredentialHash: credentialHash};
        this.invites.set(digest, reserved);
        return reserved;
    }

    async completeInvite(digest: string, participantId: string): Promise<void> {
        const invite = this.invites.get(digest);
        if (!invite) return;
        this.invites.set(digest, {...invite, state: 'redeemed', redeemedParticipantId: participantId});
    }

    async participantByCredential(roomId: string, credentialHash: string): Promise<ParticipantRecord | null> {
        return this.require(roomId).participants.find((participant) => participant.credentialHash === credentialHash) ?? null;
    }

    async handovers(roomId: string): Promise<HandoverRecord[]> {
        return [...this.require(roomId).handovers];
    }

    async messageRequest(roomId: string,eventId: string): Promise<MessageRequest | null> {const value=this.requests.get(eventId);return value?.roomId===roomId ? value : null;}
    async messageRequests(roomId: string,after: number,limit: number,recipientId?: string): Promise<RequestPage> {
        const records=[...this.requests.values()].filter(r=>r.roomId===roomId && r.seq>after && r.requiresReply && !r.responseEventId && (!recipientId || r.to===recipientId)).sort((a,b)=>a.seq-b.seq);
        return {requests:records.slice(0,limit),hasMore:records.length>limit};
    }
    async setLifecycle(roomId: string, lifecycle: RoomRecord['lifecycle']): Promise<void> {
        const table = this.require(roomId);
        table.room = {...table.room, lifecycle};
    }

    async deleteRoom(roomId: string): Promise<void> {
        const table = this.rooms.get(roomId);
        if (!table) return;
        for(const [id,request] of this.requests) if(request.roomId===roomId) this.requests.delete(id);
        table.events = [];
        table.handovers = [];
    }

    /** Simulates retention dropping the front of the log without touching room state. */
    dropHistoryBefore(roomId: string, seq: number): void {
        const table = this.require(roomId);
        table.events = table.events.filter((event) => event.seq >= seq);
        table.earliestSeq = seq;
    }

    private require(roomId: string): RoomTable {
        const table = this.rooms.get(roomId);
        if (!table) throw new Error(`unknown room ${roomId}`);
        return table;
    }
}

function upsert<T extends Record<string, unknown>>(list: T[], item: T, key: keyof T): T[] {
    const index = list.findIndex((candidate) => candidate[key] === item[key]);
    if (index === -1) return [...list, item];
    return list.map((candidate, position) => (position === index ? item : candidate));
}

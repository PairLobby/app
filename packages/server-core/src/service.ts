//! Room operations shared by every transport. The Cloudflare Durable Object and
//! the Node server both run this; only the store and the socket layer differ.

import {DEFAULT_ROOM_POLICY, ProtocolError, hashCredential, newId, newInviteCode, normalizeInviteCode} from '@pairlobby/protocol';
import type {
    AdapterCapabilities,
    MessageRequest,
    RequestPage,
    ExportResponse,
    ParticipantKind,
    ParticipantRole,
    ReadEventsResponse,
    RoomEvent,
    RoomPolicy,
    RoomSnapshot,
    SendEventRequest
} from '@pairlobby/protocol';
import {
    assertRoomWritable,
    assertRoomJoinable,
    assertCanWrite,
    assertActiveMember,
    assertController,
    authenticate,
    closeRoom,
    createRoom,
    joinAsGuest,
    joinRoom,
    leaveRoom,
    rejoinRoom,
    renameRoom,
    requestControl,
    revokeParticipant,
    sendEvent,
    setExpiry,
    setJoinPolicy,
    setLocked,
    setMuted,
    toSnapshot
} from '@pairlobby/room-core';
import type {Mutation, RoomView} from '@pairlobby/room-core';

import {stableStringify} from './stable-json.js';
import type {RoomStore} from './store.js';

type InviteDirectory = {
    reserve(code: string, roomId: string, expiresAt: number | null): Promise<boolean>;
};

type MintedInvite = {code: string; expiresAt: number | null; reusable: boolean};

type SentEventResult = {event: RoomEvent; deduplicated: boolean};

type GuestJoinInput = Identity & {participantCredential: string};

export interface Identity {
    displayName: string;
    kind: ParticipantKind;
    sessionId?: string | undefined;
    capabilities?: AdapterCapabilities | undefined;
}

export interface CreateRoomInput extends Identity {
    name: string;
    controllerCredential: string;
    participantCredential: string;
    expiresAt?: number | null | undefined;
    policy?: RoomPolicy;
}

export interface CreatedRoom {
    roomId: string;
    participantId: string;
    invite: {code: string; expiresAt: number | null};
    snapshot: RoomSnapshot;
}

export interface RedeemInput extends Identity {
    useInviteName?: boolean | undefined;
    code: string;
    attemptId: string;
    participantCredential: string;
}

export interface RedeemResult {
    roomId: string;
    participantId: string;
    role: ParticipantRole;
    replayed: boolean;
    snapshot: RoomSnapshot;
}

export type Clock = () => number;

export class RoomService {
    private readonly store: RoomStore;
    private readonly now: Clock;

    constructor(
        store: RoomStore,
        now: Clock = () => Date.now(),
        private readonly directory?: InviteDirectory
    ) {
        this.store = store;
        this.now = now;
    }

    private ctx() {
        return {now: this.now(), newEventId: () => newId('event')};
    }

    private async view(roomId: string): Promise<RoomView> {
        const view = await this.store.loadRoom(roomId);
        if (!view) {
            throw new ProtocolError('room_not_found', 'no such room');
        }
        return view;
    }

    async createRoom(input: CreateRoomInput): Promise<CreatedRoom> {
        const created = createRoom(
            {
                name: input.name,
                roomId: newId('room'),
                controllerCredentialHash: await hashCredential(input.controllerCredential),
                participantCredentialHash: await hashCredential(input.participantCredential),
                displayName: input.displayName,
                kind: input.kind,
                sessionId: input.sessionId ?? null,
                capabilities: input.capabilities ?? null,
                ...(input.expiresAt !== undefined ? {expiresAt: input.expiresAt} : {}),
                ...(input.policy ? {policy: input.policy} : {})
            },
            this.ctx()
        );
        await this.store.createRoom(created.mutation.room, created.participant, created.mutation.appendEvent);
        const invite = await this.mintInvite(created.room.roomId, input.controllerCredential, 'member');
        const view = await this.view(created.room.roomId);
        return {roomId: created.room.roomId, participantId: created.participant.participantId, invite, snapshot: toSnapshot(view)};
    }

    async mintInvite(roomId: string, credential: string, role: ParticipantRole, reusable = true, expiresAt?: number | null, defaultName?: string): Promise<MintedInvite> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        if (actor.kind === 'participant') {
            assertCanWrite(actor);
        }
        if (role === 'controller') {
            assertController(actor);
        }
        if (defaultName !== undefined && (!defaultName.trim() || defaultName.trim().length > 64)) {
            throw new ProtocolError('invalid_request', 'invite name must be between 1 and 64 characters');
        }
        assertRoomJoinable(view, this.now());
        const now = this.now();
        const lifetime = view.room.policy.inviteLifetimeMs;
        const deadline = expiresAt !== undefined ? expiresAt : lifetime === null ? null : now + lifetime;
        let code = '',
            normalized = '';
        for (let attempt = 0; attempt < 8; attempt++) {
            code = newInviteCode(this.directory ? 12 : 8);
            normalized = normalizeInviteCode(code)!;
            if (await this.store.inviteByDigest(await hashCredential(normalized))) {
                continue;
            }
            if (!this.directory || (await this.directory.reserve(code, roomId, deadline))) {
                break;
            }
            code = '';
        }
        if (!code || (await this.store.inviteByDigest(await hashCredential(normalized)))) {
            throw new ProtocolError('server_unavailable', 'Could not allocate a unique invite; try again');
        }
        await this.store.putInvite({
            digest: await hashCredential(normalized),
            roomId,
            role,
            createdAt: now,
            expiresAt: deadline,
            state: 'unused',
            ...(defaultName !== undefined ? {defaultName: defaultName.trim()} : {}),
            reusable,
            boundAttemptId: null,
            boundCredentialHash: null,
            redeemedParticipantId: null,
            recoverableUntil: deadline === null ? null : deadline + (deadline - now)
        });
        return {code, expiresAt: deadline, reusable};
    }

    /**
     * Redemption binds the invite to one attempt before membership exists, so a
     * crash between the two steps leaves a resumable reservation rather than an
     * invite a different stranger can claim.
     */
    async redeemInvite(input: RedeemInput): Promise<RedeemResult> {
        const normalized = normalizeInviteCode(input.code);
        if (!normalized) {
            throw new ProtocolError('invite_unknown', 'that invite code is not well formed');
        }
        const digest = await hashCredential(normalized);
        const invite = await this.store.inviteByDigest(digest);
        if (!invite) {
            throw new ProtocolError('invite_unknown', 'that invite code is not valid');
        }
        const now = this.now();
        const view = await this.view(invite.roomId);
        assertRoomJoinable(view, now);
        let expectedOccupantId: string | null = null;
        const credentialHash = await hashCredential(input.participantCredential);
        if (invite.boundAttemptId === input.attemptId && invite.boundCredentialHash !== credentialHash) {
            throw new ProtocolError('unauthorized', 'this join attempt belongs to another participant');
        }

        if (invite.state === 'redeemed') {
            // The same attempt retrying gets its original membership back.
            if (invite.boundAttemptId === input.attemptId) {
                const actor = authenticate(view, credentialHash, now);
                if (invite.boundCredentialHash !== credentialHash || actor.kind !== 'participant' || actor.participant.participantId !== invite.redeemedParticipantId) {
                    throw new ProtocolError('unauthorized', 'this join attempt belongs to another participant');
                }
                assertActiveMember(actor);
                return {roomId: invite.roomId, participantId: invite.redeemedParticipantId!, role: invite.role, replayed: true, snapshot: toSnapshot(view)};
            }
            if (!invite.reusable) {
                throw new ProtocolError('invite_already_redeemed', 'that invite code was already used');
            }
            // A reusable code is a seat. It reopens when its occupant leaves, but a
            // revoked participant's seat stays shut: removal is a deliberate act and
            // must not be undone by reusing the code that let them in.
            const occupant = invite.redeemedParticipantId
                ? (await this.view(invite.roomId)).participants.find((participant) => participant.participantId === invite.redeemedParticipantId)
                : undefined;
            if (occupant && occupant.revokedAt !== null) {
                throw new ProtocolError('invite_already_redeemed', 'that invite code belongs to a participant who was removed from the room');
            }
            if (occupant && occupant.leftAt === null) {
                throw new ProtocolError('invite_already_redeemed', `${occupant.displayName} is currently in the room using that code`);
            }
            expectedOccupantId = invite.redeemedParticipantId;
        } else if (invite.expiresAt !== null && now >= invite.expiresAt) {
            throw new ProtocolError('invite_expired', 'that invite code has expired');
        }

        const reserved = await this.store.reserveInvite(digest, input.attemptId, credentialHash, expectedOccupantId);
        if (!reserved) {
            throw new ProtocolError('invite_already_redeemed', 'that invite code is being redeemed by another attempt');
        }

        // Recovery path: the previous attempt created membership but lost its response.
        const existing = await this.store.participantByCredential(invite.roomId, credentialHash);
        if (existing) {
            assertActiveMember(authenticate(view, credentialHash, now));
            await this.store.completeInvite(digest, existing.participantId);
            return {roomId: invite.roomId, participantId: existing.participantId, role: existing.role, replayed: true, snapshot: toSnapshot(await this.view(invite.roomId))};
        }

        const joined = joinRoom(
            view,
            {
                role: reserved.role,
                credentialHash,
                displayName: input.useInviteName !== false ? reserved.defaultName ?? input.displayName : input.displayName,
                kind: input.kind,
                sessionId: input.sessionId ?? null,
                capabilities: input.capabilities ?? null
            },
            this.ctx()
        );
        const previousOccupant = view.participants.find((participant) => participant.participantId === invite.redeemedParticipantId);
        if (previousOccupant?.muted) {
            joined.participant.muted = true;
        }
        await this.store.apply(joined.mutation, null);
        await this.store.completeInvite(digest, joined.participant.participantId);
        return {roomId: invite.roomId, participantId: joined.participant.participantId, role: reserved.role, replayed: false, snapshot: toSnapshot(await this.view(invite.roomId))};
    }

    async send(roomId: string, credential: string, request: SendEventRequest): Promise<SentEventResult> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        if (request.type === 'message.received') {
            const participant = assertCanWrite(actor);
            // One receipt per reader, regardless of caller-supplied retry keys.
            request = {...request, idempotencyKey: `receipt-${request.payload.eventId}-${participant.participantId}`};
        }
        const requestDigest = stableStringify({type: request.type, payload: request.payload, recipientId: request.recipientId ?? null, replyTo: request.replyTo ?? null});
        const previous = await this.store.idempotencyRecord(roomId, request.idempotencyKey);
        if (previous) {
            if (previous.requestDigest !== requestDigest) {
                throw new ProtocolError('idempotency_conflict', 'this idempotency key was used with different content');
            }
            const event = await this.store.eventBySeq(roomId, previous.seq);
            if (!event) {
                throw new ProtocolError('cursor_gap', 'the original event for this idempotency key is no longer retained');
            }
            return {event, deduplicated: true};
        }
        const updates: MessageRequest[] = [];
        if (request.type === 'message.received') {
            const participant = assertCanWrite(actor);
            const target = await this.store.messageRequest(roomId, request.payload.eventId);
            const original = target ? null : await this.store.eventById(roomId, request.payload.eventId);
            if (!target && original?.type !== 'message') {
                throw new ProtocolError('invalid_request', 'no such retained message in this room');
            }
            const senderId = target?.from ?? original?.senderId;
            if (senderId === participant.participantId) {
                throw new ProtocolError('unauthorized', 'a sender cannot acknowledge their own message');
            }
            // Other readers do not satisfy the addressed recipient's obligation.
            if (target?.to === participant.participantId) {
                updates.push({...target, receivedAt: target.receivedAt ?? this.now()});
            }
        } else if (request.type === 'message.delivery_failed' || (request.type === 'message' && request.replyTo)) {
            const id = request.type === 'message.delivery_failed' ? request.payload.eventId : request.replyTo!;
            const target = await this.store.messageRequest(roomId, id);
            if (!target) {
                throw new ProtocolError('invalid_request', 'no such addressed message in this room');
            }
            if (actor.kind !== 'participant' || actor.participant.participantId !== target.to) {
                throw new ProtocolError('unauthorized', 'only the addressed recipient may acknowledge or answer this message');
            }
            if (request.type === 'message.delivery_failed') {
                if (target.responseEventId) {
                    throw new ProtocolError('invalid_request', 'this request is already answered');
                }
                updates.push({...target, failureAt: this.now(), failureReason: request.payload.reason});
            } else {
                if (request.recipientId !== target.from) {
                    throw new ProtocolError('invalid_request', 'a reply must be addressed to the original sender');
                }
                if (!target.requiresReply) {
                    throw new ProtocolError('invalid_request', 'this message is already a reply or progress update');
                }
                if (target.responseEventId) {
                    throw new ProtocolError('invalid_request', 'this request already has a final reply');
                }
                if (target.receivedAt === null) {
                    throw new ProtocolError('invalid_request', 'acknowledge the request before replying');
                }
                updates.push({...target, progressAt: request.payload.responseStage === 'progress' ? this.now() : target.progressAt});
            }
        } else if (request.type === 'message' && request.payload.responseStage) {
            throw new ProtocolError('invalid_request', 'responseStage requires replyTo');
        }
        if (request.type === 'message' && request.recipientId && !request.replyTo) {
            const pending = await this.store.messageRequests(roomId, 0, 1000);
            if (pending.requests.length >= 1000) {
                throw new ProtocolError('quota_exceeded', 'answer or resolve pending requests before creating more');
            }
        }
        const mutation = sendEvent(view, await hashCredential(credential), request, this.ctx());
        if (request.type === 'message' && request.recipientId) {
            if (request.replyTo && request.payload.responseStage !== 'progress') {
                const target = updates[0]!;
                updates[0] = {...target, responseEventId: mutation.appendEvent.eventId, respondedAt: this.now()};
            }
            updates.push({
                roomId,
                eventId: mutation.appendEvent.eventId,
                seq: mutation.appendEvent.seq,
                from: mutation.appendEvent.senderId!,
                to: request.recipientId,
                text: request.payload.text,
                at: mutation.appendEvent.at,
                requiresReply: !request.replyTo,
                receivedAt: null,
                responseEventId: null,
                respondedAt: null,
                progressAt: null
            });
        }
        mutation.upsertRequests = updates;
        await this.store.apply(mutation, {key: request.idempotencyKey, requestDigest});
        return {event: mutation.appendEvent, deduplicated: false};
    }

    async acknowledgeMessage(roomId: string, credential: string, eventId: string): Promise<MessageRequest | null> {
        const actor = authenticate(await this.view(roomId), await hashCredential(credential), this.now());
        const participant = assertCanWrite(actor);
        const target = await this.store.messageRequest(roomId, eventId);
        if (target?.to === participant.participantId && target.receivedAt !== null) {
            return target;
        }
        const key = `receipt-${eventId}-${participant.participantId}`;
        const saved = await this.store.idempotencyRecord(roomId, key);
        const digest = stableStringify({type: 'message.received', payload: {eventId}, recipientId: null, replyTo: null});
        if (saved && saved.requestDigest !== digest) {
            throw new ProtocolError('idempotency_conflict', 'the receipt key was used with different content');
        }
        // A saved receipt remains confirmed even after its event was pruned.
        if (!saved) {
            await this.send(roomId, credential, {type: 'message.received', payload: {eventId}, idempotencyKey: key});
        }
        return this.store.messageRequest(roomId, eventId);
    }

    async requests(roomId: string, credential: string, after = 0, limit = 100, recipientId?: string): Promise<RequestPage> {
        authenticate(await this.view(roomId), await hashCredential(credential), this.now());
        return this.store.messageRequests(roomId, after, limit, recipientId);
    }
    async request(roomId: string, credential: string, eventId: string): Promise<MessageRequest> {
        authenticate(await this.view(roomId), await hashCredential(credential), this.now());
        const request = await this.store.messageRequest(roomId, eventId);
        if (!request) {
            throw new ProtocolError('invalid_request', 'no such addressed message');
        }
        return request;
    }

    async setLocked(roomId: string, credential: string, locked: boolean): Promise<RoomEvent> {
        return this.applyOne(setLocked(await this.view(roomId), await hashCredential(credential), locked, this.ctx()));
    }

    async setMuted(roomId: string, credential: string, participantId: string, muted: boolean): Promise<RoomEvent> {
        return this.applyOne(setMuted(await this.view(roomId), await hashCredential(credential), participantId, muted, this.ctx()));
    }

    async control(roomId: string, credential: string, targetParticipantId: string, paused: boolean): Promise<RoomEvent> {
        return this.applyOne(requestControl(await this.view(roomId), await hashCredential(credential), targetParticipantId, paused, this.ctx()));
    }

    async revoke(roomId: string, credential: string, targetParticipantId: string): Promise<RoomEvent> {
        return this.applyOne(revokeParticipant(await this.view(roomId), await hashCredential(credential), targetParticipantId, this.ctx()));
    }

    async leave(roomId: string, credential: string): Promise<RoomEvent> {
        return this.applyOne(leaveRoom(await this.view(roomId), await hashCredential(credential), this.ctx()));
    }

    async rejoin(roomId: string, credential: string): Promise<RoomSnapshot> {
        const view = await this.view(roomId);
        const hash = await hashCredential(credential);
        const actor = authenticate(view, hash, this.now());
        if (actor.kind !== 'participant') {
            throw new ProtocolError('unauthorized', 'rejoining requires the saved participant credential');
        }
        if (actor.participant.leftAt === null) {
            return toSnapshot(view);
        }
        await this.applyOne(rejoinRoom(view, hash, this.ctx()));
        return this.snapshot(roomId, credential);
    }

    async rename(roomId: string, credential: string, name: string): Promise<RoomEvent> {
        return this.applyOne(renameRoom(await this.view(roomId), await hashCredential(credential), name, this.ctx()));
    }

    async setJoinPolicy(roomId: string, credential: string, joinPolicy: 'invite_only' | 'open_to_guests'): Promise<RoomEvent> {
        return this.applyOne(setJoinPolicy(await this.view(roomId), await hashCredential(credential), joinPolicy, this.ctx()));
    }

    /** Guest entry. Knowing the room id is the entire claim, so the room must allow it. */
    async joinAsGuest(roomId: string, input: GuestJoinInput): Promise<RedeemResult> {
        const view = await this.view(roomId);
        assertRoomJoinable(view, this.now());
        const credentialHash = await hashCredential(input.participantCredential);
        const existing = await this.store.participantByCredential(roomId, credentialHash);
        if (existing) {
            authenticate(view, credentialHash, this.now());
            return {roomId, participantId: existing.participantId, role: existing.role, replayed: true, snapshot: toSnapshot(view)};
        }

        const joined = joinAsGuest(
            view,
            {
                credentialHash,
                displayName: input.displayName,
                kind: input.kind,
                sessionId: input.sessionId ?? null,
                capabilities: input.capabilities ?? null
            },
            this.ctx()
        );
        await this.store.apply(joined.mutation, null);
        return {roomId, participantId: joined.participant.participantId, role: 'guest', replayed: false, snapshot: toSnapshot(await this.view(roomId))};
    }

    async setExpiry(roomId: string, credential: string, expiresAt: number | null): Promise<RoomEvent> {
        return this.applyOne(setExpiry(await this.view(roomId), await hashCredential(credential), expiresAt, this.ctx()));
    }

    async close(roomId: string, credential: string): Promise<RoomEvent> {
        return this.applyOne(closeRoom(await this.view(roomId), await hashCredential(credential), this.ctx()));
    }

    async read(roomId: string, credential: string, after: number, limit: number): Promise<ReadEventsResponse> {
        const view = await this.view(roomId);
        authenticate(view, await hashCredential(credential), this.now());
        if (after > 0 && after < view.earliestSeq - 1) {
            throw new ProtocolError('cursor_gap', 'history before this cursor is no longer retained', {earliestAvailableSeq: view.earliestSeq});
        }
        const page = await this.store.readEvents(roomId, after, limit);
        return {events: page.events, earliestSeq: view.earliestSeq, latestSeq: view.room.nextSeq - 1, hasMore: page.hasMore};
    }

    async snapshot(roomId: string, credential: string): Promise<RoomSnapshot> {
        const view = await this.view(roomId);
        authenticate(view, await hashCredential(credential), this.now());
        return toSnapshot(view);
    }

    /** Returns the history the caller's room still retains, and says so when retention already dropped some. */
    async export(roomId: string, credential: string): Promise<ExportResponse> {
        const view = await this.view(roomId);
        authenticate(view, await hashCredential(credential), this.now());
        const collected: RoomEvent[] = [];
        let after = 0;
        for (;;) {
            const page = await this.store.readEvents(roomId, after, 500);
            collected.push(...page.events);
            if (!page.hasMore || page.events.length === 0) {
                break;
            }
            after = page.events.at(-1)!.seq;
        }
        return {room: toSnapshot(view), events: collected, handovers: await this.store.handovers(roomId), exportedAt: this.now(), complete: view.earliestSeq <= 1};
    }

    /** Makes the room inaccessible immediately; physical cleanup may lag. */
    async delete(roomId: string, credential: string): Promise<void> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        if (actor.kind !== 'controller' && actor.participant.role !== 'controller') {
            throw new ProtocolError('unauthorized', 'deleting a room requires the controller credential');
        }
        await this.store.setLifecycle(roomId, 'deleted');
        await this.store.deleteRoom(roomId);
    }

    private async applyOne(mutation: Mutation): Promise<RoomEvent> {
        await this.store.apply(mutation, null);
        return mutation.appendEvent;
    }
}

export {DEFAULT_ROOM_POLICY};

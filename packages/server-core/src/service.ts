//! Room operations shared by every transport. The Cloudflare Durable Object and
//! the Node server both run this; only the store and the socket layer differ.

import {DEFAULT_ROOM_POLICY, ProtocolError, hashCredential, newId, newInviteCode, normalizeInviteCode} from '@pairlobby/protocol';
import type {AdapterCapabilities, ExportResponse, ParticipantKind, ParticipantRole, ReadEventsResponse, RoomEvent, RoomPolicy, RoomSnapshot, SendEventRequest} from '@pairlobby/protocol';
import {assertRoomWritable, authenticate, closeRoom, createRoom, joinRoom, leaveRoom, requestControl, revokeParticipant, sendEvent, toSnapshot} from '@pairlobby/room-core';
import type {Mutation, RoomView} from '@pairlobby/room-core';

import {stableStringify} from './stable-json.js';
import type {RoomStore} from './store.js';

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
    policy?: RoomPolicy;
}

export interface CreatedRoom {
    roomId: string;
    participantId: string;
    invite: {code: string; expiresAt: number};
    snapshot: RoomSnapshot;
}

export interface RedeemInput extends Identity {
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

    constructor(store: RoomStore, now: Clock = () => Date.now()) {
        this.store = store;
        this.now = now;
    }

    private ctx() {
        return {now: this.now(), newEventId: () => newId('event')};
    }

    private async view(roomId: string): Promise<RoomView> {
        const view = await this.store.loadRoom(roomId);
        if (!view) throw new ProtocolError('room_not_found', 'no such room');
        return view;
    }

    async createRoom(input: CreateRoomInput): Promise<CreatedRoom> {
        const created = createRoom({
            name: input.name,
            roomId: newId('room'),
            controllerCredentialHash: await hashCredential(input.controllerCredential),
            participantCredentialHash: await hashCredential(input.participantCredential),
            displayName: input.displayName,
            kind: input.kind,
            sessionId: input.sessionId ?? null,
            capabilities: input.capabilities ?? null,
            ...(input.policy ? {policy: input.policy} : {}),
        }, this.ctx());
        await this.store.createRoom(created.mutation.room, created.participant, created.mutation.appendEvent);
        const invite = await this.mintInvite(created.room.roomId, input.controllerCredential, 'member');
        const view = await this.view(created.room.roomId);
        return {roomId: created.room.roomId, participantId: created.participant.participantId, invite, snapshot: toSnapshot(view)};
    }

    async mintInvite(roomId: string, credential: string, role: ParticipantRole): Promise<{code: string; expiresAt: number}> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        if (actor.kind !== 'controller' && actor.participant.role !== 'controller' && actor.participant.kind !== 'agent') {
            throw new ProtocolError('unauthorized', 'this action requires a room participant');
        }
        assertRoomWritable(view, this.now());
        const code = newInviteCode();
        const normalized = normalizeInviteCode(code)!;
        const now = this.now();
        await this.store.putInvite({
            digest: await hashCredential(normalized),
            roomId,
            role,
            createdAt: now,
            expiresAt: now + view.room.policy.inviteLifetimeMs,
            state: 'unused',
            boundAttemptId: null,
            boundCredentialHash: null,
            redeemedParticipantId: null,
            recoverableUntil: now + view.room.policy.inviteLifetimeMs * 2,
        });
        return {code, expiresAt: now + view.room.policy.inviteLifetimeMs};
    }

    /**
     * Redemption binds the invite to one attempt before membership exists, so a
     * crash between the two steps leaves a resumable reservation rather than an
     * invite a different stranger can claim.
     */
    async redeemInvite(input: RedeemInput): Promise<RedeemResult> {
        const normalized = normalizeInviteCode(input.code);
        if (!normalized) throw new ProtocolError('invite_unknown', 'that invite code is not well formed');
        const digest = await hashCredential(normalized);
        const invite = await this.store.inviteByDigest(digest);
        if (!invite) throw new ProtocolError('invite_unknown', 'that invite code is not valid');
        const now = this.now();
        const credentialHash = await hashCredential(input.participantCredential);

        if (invite.state === 'redeemed') {
            if (invite.boundAttemptId !== input.attemptId) throw new ProtocolError('invite_already_redeemed', 'that invite code was already used');
            const view = await this.view(invite.roomId);
            return {roomId: invite.roomId, participantId: invite.redeemedParticipantId!, role: invite.role, replayed: true, snapshot: toSnapshot(view)};
        }
        if (now >= invite.expiresAt) throw new ProtocolError('invite_expired', 'that invite code has expired');

        const view = await this.view(invite.roomId);
        assertRoomWritable(view, now);

        const reserved = await this.store.reserveInvite(digest, input.attemptId, credentialHash);
        if (!reserved) throw new ProtocolError('invite_already_redeemed', 'that invite code is being redeemed by another attempt');

        // Recovery path: the previous attempt created membership but lost its response.
        const existing = await this.store.participantByCredential(invite.roomId, credentialHash);
        if (existing) {
            await this.store.completeInvite(digest, existing.participantId);
            return {roomId: invite.roomId, participantId: existing.participantId, role: existing.role, replayed: true, snapshot: toSnapshot(await this.view(invite.roomId))};
        }

        const joined = joinRoom(view, {
            role: reserved.role,
            credentialHash,
            displayName: input.displayName,
            kind: input.kind,
            sessionId: input.sessionId ?? null,
            capabilities: input.capabilities ?? null,
        }, this.ctx());
        await this.store.apply(joined.mutation, null);
        await this.store.completeInvite(digest, joined.participant.participantId);
        return {roomId: invite.roomId, participantId: joined.participant.participantId, role: reserved.role, replayed: false, snapshot: toSnapshot(await this.view(invite.roomId))};
    }

    async send(roomId: string, credential: string, request: SendEventRequest): Promise<{event: RoomEvent; deduplicated: boolean}> {
        const requestDigest = stableStringify({type: request.type, payload: request.payload, recipientId: request.recipientId ?? null, replyTo: request.replyTo ?? null});
        const previous = await this.store.idempotencyRecord(roomId, request.idempotencyKey);
        if (previous) {
            if (previous.requestDigest !== requestDigest) throw new ProtocolError('idempotency_conflict', 'this idempotency key was used with different content');
            const event = await this.store.eventBySeq(roomId, previous.seq);
            if (!event) throw new ProtocolError('cursor_gap', 'the original event for this idempotency key is no longer retained');
            return {event, deduplicated: true};
        }
        const mutation = sendEvent(await this.view(roomId), await hashCredential(credential), request, this.ctx());
        await this.store.apply(mutation, {key: request.idempotencyKey, requestDigest});
        return {event: mutation.appendEvent, deduplicated: false};
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
            if (!page.hasMore || page.events.length === 0) break;
            after = page.events.at(-1)!.seq;
        }
        return {room: toSnapshot(view), events: collected, handovers: await this.store.handovers(roomId), exportedAt: this.now(), complete: view.earliestSeq <= 1};
    }

    /** Makes the room inaccessible immediately; physical cleanup may lag. */
    async delete(roomId: string, credential: string): Promise<void> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        if (actor.kind !== 'controller' && actor.participant.role !== 'controller') throw new ProtocolError('unauthorized', 'deleting a room requires the controller credential');
        await this.store.setLifecycle(roomId, 'deleted');
        await this.store.deleteRoom(roomId);
    }

    private async applyOne(mutation: Mutation): Promise<RoomEvent> {
        await this.store.apply(mutation, null);
        return mutation.appendEvent;
    }
}

export {DEFAULT_ROOM_POLICY};

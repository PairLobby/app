//! Room operations shared by every transport. The Cloudflare Durable Object and
//! the Node server both run this; only the store and the socket layer differ.

import {DEFAULT_ROOM_POLICY, ProtocolError, hashCredential, newId, newInviteCode, normalizeInviteCode} from '@pairlobby/protocol';
import type {
    AdapterCapabilities,
    AutoClosePolicy,
    MessageRequest,
    RequestPage,
    ExportResponse,
    ParticipantKind,
    RenameSelfRequest,
    NameSource,
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
    assertCanAcknowledge,
    assertActiveMember,
    assertController,
    authenticate,
    closeRoom,
    createRoom,
    joinAsGuest,
    joinOnLocalNetwork,
    joinRoom,
    leaveRoom,
    rejoinRoom,
    renameRoom,
    renameSelf,
    requestControl,
    revokeParticipant,
    sendEvent,
    setExpiry,
    setAutoClose,
    setInviteRole,
    setJoinPolicy,
    setLocalJoin,
    setLocked,
    setMuted,
    setParticipantRole,
    toSnapshot
} from '@pairlobby/room-core';
import type {Mutation, RoomView} from '@pairlobby/room-core';

import {stableStringify} from './stable-json.js';
import {TurnCoordinator, assertTurn} from './turns.js';
import type {RoomStore} from './store.js';
import {AutoCloseStore} from './auto-close-store.js';

type InviteDirectory = {
    reserve(code: string, roomId: string, expiresAt: number | null): Promise<boolean>;
};

type MintedInvite = {code: string; expiresAt: number | null; reusable: boolean};

type SentEventResult = {event: RoomEvent; deduplicated: boolean};

type GuestJoinInput = Identity & {participantCredential: string};

export interface InterruptResult {
    event: RoomEvent;
    /** Requests whose running turn was fenced; empty when the agent was between turns. */
    fenced: string[];
}

/** One scheduler pass: rooms closed, whether more were already due, and the next deadline. */
export interface AutoCloseSweep {
    closed: number;
    more: boolean;
    nextAt: number | null;
}

export interface Identity {
    displayName: string;
    nameSource?: NameSource | undefined;
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
    /**
     * Chosen by a server that routes by room id before the room exists, such as a
     * relay with one Durable Object per room. Never taken from a client request.
     */
    roomId?: string;
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
    readonly turns: TurnCoordinator;

    constructor(
        store: RoomStore,
        now: Clock = () => Date.now(),
        private readonly directory?: InviteDirectory
    ) {
        this.now = now;
        this.store = new AutoCloseStore(store, () => this.now());
        this.turns = new TurnCoordinator(this.store, now);
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
                roomId: input.roomId ?? newId('room'),
                controllerCredentialHash: await hashCredential(input.controllerCredential),
                participantCredentialHash: await hashCredential(input.participantCredential),
                displayName: input.displayName,
                kind: input.kind,
                nameSource: input.nameSource,
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
                return {roomId: invite.roomId, participantId: invite.redeemedParticipantId!, role: actor.participant.role, replayed: true, snapshot: toSnapshot(view)};
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

        const previousOccupant = view.participants.find((participant) => participant.participantId === invite.redeemedParticipantId);
        // A demoted admin must not regain privileges through the old invite seat.
        const admissionRole = reserved.role === 'controller' && previousOccupant && previousOccupant.role !== 'controller' ? 'member' : reserved.role;
        const joined = joinRoom(
            view,
            {
                role: admissionRole,
                credentialHash,
                displayName: input.useInviteName !== false ? reserved.defaultName ?? input.displayName : input.displayName,
                kind: input.kind,
                nameSource: input.nameSource,
                sessionId: input.sessionId ?? null,
                capabilities: input.capabilities ?? null
            },
            this.ctx()
        );
        if (previousOccupant?.muted) {
            joined.participant.muted = true;
        }
        await this.store.apply(joined.mutation, null);
        await this.store.completeInvite(digest, joined.participant.participantId);
        return {roomId: invite.roomId, participantId: joined.participant.participantId, role: admissionRole, replayed: false, snapshot: toSnapshot(await this.view(invite.roomId))};
    }

    async send(roomId: string, credential: string, request: SendEventRequest): Promise<SentEventResult> {
        const view = await this.view(roomId);
        // One clock reading for the whole operation: the request record and the event it
        // produces must carry the same time, or a client comparing them sees one as stale.
        const now = this.now();
        const actor = authenticate(view, await hashCredential(credential), now);
        const participantId = actor.kind === 'participant' ? actor.participant.participantId : undefined;
        const group = request.recipientIds !== undefined || request.allRecipients === true;
        if (group && (request.type !== 'message' || request.replyTo || request.recipientId || (request.recipientIds && request.allRecipients))) {
            throw new ProtocolError('invalid_request', 'group recipients are only valid for a new message; choose names or all');
        }
        if (request.type === 'message.received') {
            const participant = assertCanAcknowledge(actor);
            const target = await this.turns.resolve(roomId, request.payload.eventId, participant.participantId);
            const eventId = target?.conversationId ?? request.payload.eventId;
            request = {...request, payload: {...request.payload, eventId}, ...(!request.payload.action ? {idempotencyKey: `${request.payload.stage === 'read' ? 'read' : 'receipt'}-${eventId}-${participant.participantId}`} : {})};
        }
        const requestDigest = stableStringify({type: request.type, payload: request.payload, recipientId: request.recipientId ?? null, replyTo: request.replyTo ?? null,
            ...(request.recipientIds ? {recipientIds: request.recipientIds} : {}), ...(request.allRecipients ? {allRecipients: true} : {}), ...(request.quoteOf ? {quoteOf: request.quoteOf} : {})});
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
        let quoteContext = '';
        if (request.quoteOf) {
            if (request.type !== 'message' || request.replyTo) {
                throw new ProtocolError('invalid_request', 'quoteOf is only valid on a new message, without replyTo');
            }
            const original = await this.store.eventById(roomId, request.quoteOf);
            if (original?.type !== 'message') {
                throw new ProtocolError('invalid_request', 'the quoted message is no longer retained in this room');
            }
            const sender = view.participants.find((participant) => participant.participantId === original.senderId)?.displayName ?? original.senderId;
            const excerpt = original.payload.text.slice(0, 4000);
            quoteContext = `Quoted message from ${sender}:\n${excerpt}${excerpt.length < original.payload.text.length ? '\n[quote shortened]' : ''}\n\nFollow-up:\n`;
        }
        let recipients = request.recipientId ? [request.recipientId] : [];
        if (group) {
            const eligible = view.participants.filter((participant) => participant.kind === 'agent' && participant.role !== 'guest' && participant.leftAt === null && participant.revokedAt === null && !participant.muted && participant.participantId !== participantId).sort((a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId));
            recipients = request.allRecipients ? eligible.map((participant) => participant.participantId) : [...new Set(request.recipientIds!)];
            if (!recipients.length || recipients.some((id) => !eligible.some((participant) => participant.participantId === id))) {
                throw new ProtocolError('invalid_request', 'address one or more active, unmuted agent members other than yourself');
            }
            if (request.allRecipients) {
                const start = (view.room.allStartIndex ?? 0) % recipients.length;
                recipients = [...recipients.slice(start), ...recipients.slice(0, start)];
            }
        }
        const updates: MessageRequest[] = [];
        let replyTarget: MessageRequest | null = null;
        if (request.type === 'message.received') {
            const participant = assertCanAcknowledge(actor);
            const target = await this.turns.resolve(roomId, request.payload.eventId, participant.participantId);
            const original = target ? null : await this.store.eventById(roomId, request.payload.eventId);
            if (!target && original?.type !== 'message') {
                throw new ProtocolError('invalid_request', 'no such retained message in this room');
            }
            if ((target?.from ?? original?.senderId) === participant.participantId) {
                throw new ProtocolError('unauthorized', 'a sender cannot acknowledge their own message');
            }
            if (target?.to === participant.participantId) {
                updates.push({...target, receivedAt: target.receivedAt ?? now, ...(request.payload.stage === 'read' ? {readAt: target.readAt ?? now} : {})});
            }
            const action = request.payload.action;
            if (action) {
                if (request.payload.responseEventId && action !== 'done') {
                    throw new ProtocolError('invalid_request', 'A linked answer requires the done action.');
                }
                if (action !== 'reply_pending' && request.payload.stage !== 'read') {
                    throw new ProtocolError('invalid_request', 'Declare reading before a model action.');
                }
                if (['waiting', 'no_action', 'declined'].includes(action) && !request.payload.reason?.trim()) {
                    throw new ProtocolError('invalid_request', 'This action needs a reason.');
                }
                if (target?.to === participant.participantId && !target.requiresReply && target.action === action && target.actionReason === request.payload.reason && ['no_action', 'declined'].includes(action)) {
                    updates[0] = {...target, readAt: target.readAt ?? now};
                } else if (target?.to === participant.participantId && (target.requiresReply || target.responseEventId || target.action || target.turnRequired)) {
                    assertCanWrite(actor);
                    if (target.responseEventId || !target.requiresReply) {
                        throw new ProtocolError('invalid_request', 'This request is already resolved.');
                    }
                    if (action === 'done') {
                        const answer = request.payload.responseEventId ? await this.store.eventById(roomId, request.payload.responseEventId) : null;
                        const origin = await this.store.eventById(roomId, target.conversationId ?? target.eventId);
                        if (answer?.type !== 'message' || answer.senderId !== participant.participantId || (origin ? answer.seq <= origin.seq : answer.at < target.at) || answer.replyTo || answer.recipientIds || (answer.recipientId !== null && answer.recipientId !== target.from) || answer.payload.responseStage === 'progress') {
                            throw new ProtocolError('invalid_request', 'Link an existing unthreaded answer authored by this recipient after the request.');
                        }
                        if (target.turnRequired && !target.failureAt) {
                            assertTurn(target, request.turnToken, now);
                        }
                        if (['cancelled', 'skipped', 'passed'].includes(target.turnStatus ?? '')) {
                            throw new ProtocolError('invalid_request', 'A cancelled or skipped request cannot be completed by a late answer.');
                        }
                        updates[0] = {...updates[0]!, responseEventId: answer.eventId, responseText: answer.payload.text, respondedAt: now, action, actionAt: now, ...(target.turnRequired ? {turnStatus: 'answered'} : {})};
                        // Reclassify the standalone answer: it must not leave a reverse
                        // "please reply" obligation on the original asker.
                        const reverse = await this.store.messageRequest(roomId, answer.eventId);
                        if (reverse && !reverse.responseEventId) {
                            updates.push({...reverse, requiresReply: false, ...(reverse.turnRequired ? {turnStatus: 'cancelled', turnToken: '', turnExpiresAt: 0} : {})});
                        }
                    } else {
                        if (target.failureAt) {
                            throw new ProtocolError('invalid_request', 'This attempt failed. Link a completed answer explicitly instead of restarting it through status.');
                        }
                        assertTurn(target, request.turnToken, now);
                        const terminal = action === 'no_action' || action === 'declined';
                        updates[0] = {...updates[0]!, action, actionAt: now, actionReason: request.payload.reason ?? '', ...(terminal ? {requiresReply: false, ...(target.turnRequired ? {turnStatus: 'passed'} : {})} : {})};
                    }
                } else if (action !== 'no_action') {
                    throw new ProtocolError('unauthorized', 'Only the addressed recipient may change the action for this request.');
                } else if (target?.to === participant.participantId) {
                    updates[0] = {...updates[0]!, action, actionAt: now, actionReason: request.payload.reason!};
                }
            } else if (request.payload.responseEventId) {
                throw new ProtocolError('invalid_request', 'A linked answer requires the done action.');
            }
        } else if (request.type === 'message.delivery_failed' || (request.type === 'message' && request.replyTo)) {
            const id = request.type === 'message.delivery_failed' ? request.payload.eventId : request.replyTo!;
            const target = await this.turns.resolve(roomId, id, participantId);
            if (!target) {
                throw new ProtocolError('invalid_request', 'no such addressed message in this room');
            }
            if (participantId !== target.to) {
                throw new ProtocolError('unauthorized', 'only the addressed recipient may answer this message');
            }
            assertTurn(target, request.turnToken, now);
            if (request.type === 'message.delivery_failed') {
                if (target.responseEventId || !target.requiresReply) {
                    throw new ProtocolError('invalid_request', 'this request is already finished');
                }
                updates.push({...target, failureAt: now, failureReason: request.payload.reason, ...(request.payload.stage ? {failureStage: request.payload.stage} : {}), ...(target.turnRequired ? {turnStatus: 'failed' as const} : {})});
            } else {
                if (request.recipientId !== target.from) {
                    throw new ProtocolError('invalid_request', 'a reply must be addressed to the original sender');
                }
                if (!target.requiresReply || target.responseEventId) {
                    throw new ProtocolError('invalid_request', 'this request is already finished or is itself a reply');
                }
                if (target.receivedAt === null) {
                    throw new ProtocolError('invalid_request', 'acknowledge the request before replying');
                }
                replyTarget = target;
                updates.push({...target, progressAt: request.payload.responseStage === 'progress' ? now : target.progressAt});
            }
        } else if (request.type === 'message' && request.payload.responseStage) {
            throw new ProtocolError('invalid_request', 'responseStage requires replyTo');
        }
        if (request.type === 'message' && recipients.length && !request.replyTo) {
            const pending = await this.store.messageRequests(roomId, 0, 1000);
            if (pending.requests.length + recipients.length > 1000) {
                throw new ProtocolError('quota_exceeded', 'answer or resolve pending requests before creating more');
            }
        }
        const outgoing = replyTarget?.conversationId ? {...request, replyTo: replyTarget.conversationId} : request;
        const mutation = sendEvent(view, await hashCredential(credential), outgoing, {now, newEventId: () => newId('event')});
        if (group) {
            mutation.appendEvent.recipientIds = recipients;
            mutation.appendEvent.allRecipients = request.allRecipients === true;
            if (request.allRecipients) {
                mutation.room.allStartIndex = (view.room.allStartIndex ?? 0) + 1;
            }
        }
        if (replyTarget && request.type === 'message' && request.payload.responseStage !== 'progress') {
            updates[0] = {...replyTarget, responseEventId: mutation.appendEvent.eventId, respondedAt: now, responseText: request.payload.text, action: 'done', actionAt: now, ...(replyTarget.turnRequired ? {turnStatus: 'answered' as const} : {})};
        }
        if (updates.some((entry) => entry.turnRequired) && (request.type !== 'message.received' || request.payload.action)) {
            const revision = view.room.turnRevision ?? 0;
            mutation.expectedTurnRevision = revision;
            mutation.room.turnRevision = revision + 1;
            mutation.room.turnChangedAt = now;
            for (const entry of updates) {
                entry.turnRevision = revision + 1;
            }
        }
        if (request.type === 'message' && recipients.length) {
            let seq = Math.max(view.room.nextRequestSeq ?? 0, mutation.appendEvent.seq);
            for (const recipient of recipients) {
                updates.push({
                    roomId, eventId: group ? newId('event') : mutation.appendEvent.eventId, seq: seq++,
                    from: mutation.appendEvent.senderId!, to: recipient, text: quoteContext + request.payload.text, at: mutation.appendEvent.at,
                    requiresReply: !request.replyTo, receivedAt: null, responseEventId: null, respondedAt: null, progressAt: null,
                    ...(group ? {conversationId: mutation.appendEvent.eventId, turnRequired: true} : {})
                });
            }
            mutation.room.nextRequestSeq = seq;
        }
        mutation.upsertRequests = updates;
        await this.store.apply(mutation, {key: request.idempotencyKey, requestDigest});
        return {event: mutation.appendEvent, deduplicated: false};
    }

    async acknowledgeMessage(roomId: string, credential: string, eventId: string): Promise<MessageRequest | null> {
        const actor = authenticate(await this.view(roomId), await hashCredential(credential), this.now());
        const participant = assertCanAcknowledge(actor);
        const target = await this.turns.resolve(roomId, eventId, participant.participantId);
        if (target?.to === participant.participantId && target.receivedAt !== null) {
            return this.publicRequest(target);
        }
        const root = target?.conversationId ?? eventId;
        const key = `receipt-${root}-${participant.participantId}`;
        const saved = await this.store.idempotencyRecord(roomId, key);
        const digest = stableStringify({type: 'message.received', payload: {eventId: root}, recipientId: null, replyTo: null});
        if (saved && saved.requestDigest !== digest) {
            throw new ProtocolError('idempotency_conflict', 'the receipt key was used with different content');
        }
        if (!saved) {
            await this.send(roomId, credential, {type: 'message.received', payload: {eventId: root}, idempotencyKey: key});
        }
        const updated = await this.turns.resolve(roomId, eventId, participant.participantId);
        return updated ? this.publicRequest(updated) : null;
    }

    private publicRequest(request: MessageRequest): MessageRequest {
        const result = {...request};
        delete result.turnToken;
        delete result.turnClaimId;
        return result;
    }

    async requests(roomId: string, credential: string, after = 0, limit = 100, recipientId?: string, supportsTurns = true): Promise<RequestPage> {
        authenticate(await this.view(roomId), await hashCredential(credential), this.now());
        if (supportsTurns) {
            const page = await this.store.messageRequests(roomId, after, limit, recipientId);
            return {...page, requests: page.requests.map((request) => this.publicRequest(request))};
        }
        // Old receivers must not start guarded work, nor get an empty page with
        // hasMore=true that gives their cursor no way to advance.
        let cursor = after;
        const visible: MessageRequest[] = [];
        for (let pageNumber = 0; pageNumber < 11; pageNumber++) {
            const page = await this.store.messageRequests(roomId, cursor, Math.max(limit, 100), recipientId);
            visible.push(...page.requests.filter((request) => !request.turnRequired));
            if (visible.length >= limit || !page.hasMore) {
                return {requests: visible.slice(0, limit).map((request) => this.publicRequest(request)), hasMore: visible.length > limit || page.hasMore};
            }
            const next = page.requests.at(-1)?.seq;
            if (next === undefined || next <= cursor) {
                throw new ProtocolError('server_unavailable', 'request pagination did not advance');
            }
            cursor = next;
        }
        throw new ProtocolError('server_unavailable', 'pending request limit exceeded');
    }

    async request(roomId: string, credential: string, eventId: string): Promise<MessageRequest> {
        const actor = authenticate(await this.view(roomId), await hashCredential(credential), this.now());
        const request = await this.turns.resolve(roomId, eventId, actor.kind === 'participant' ? actor.participant.participantId : undefined);
        if (!request) {
            throw new ProtocolError('invalid_request', 'no such addressed delivery; use a recipient delivery ID for a group message');
        }
        return this.publicRequest(request);
    }

    async setLocked(roomId: string, credential: string, locked: boolean): Promise<RoomEvent> {
        return this.applyOne(setLocked(await this.view(roomId), await hashCredential(credential), locked, this.ctx()));
    }

    async setMuted(roomId: string, credential: string, participantId: string, muted: boolean): Promise<RoomEvent> {
        return this.applyOne(setMuted(await this.view(roomId), await hashCredential(credential), participantId, muted, this.ctx()));
    }

    async setRole(roomId: string, credential: string, participantId: string, role: 'member' | 'controller'): Promise<RoomSnapshot> {
        const mutation = setParticipantRole(await this.view(roomId), await hashCredential(credential), participantId, role, this.ctx());
        if (mutation) {
            await this.applyOne(mutation);
        }
        return toSnapshot(await this.view(roomId));
    }

    async control(roomId: string, credential: string, targetParticipantId: string, paused: boolean): Promise<RoomEvent> {
        return this.applyOne(requestControl(await this.view(roomId), await hashCredential(credential), targetParticipantId, paused, this.ctx()));
    }

    /**
     * Stops one agent: holds its later work like a pause, then fences the turn it is
     * running so a late answer cannot be posted. Its receiver acknowledges what it could
     * actually stop. Other agents and the rest of a group round are not affected.
     */
    async interrupt(roomId: string, credential: string, targetParticipantId: string): Promise<InterruptResult> {
        const event = await this.applyOne(requestControl(await this.view(roomId), await hashCredential(credential), targetParticipantId, true, this.ctx(), true));
        const fenced = await this.turns.fenceRunning(roomId, credential, targetParticipantId);
        return {event, fenced};
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

    async renameSelf(roomId: string, credential: string, input: RenameSelfRequest): Promise<RoomSnapshot> {
        const mutation = renameSelf(await this.view(roomId), await hashCredential(credential), input, this.ctx());
        if (mutation) {
            await this.applyOne(mutation);
        }
        return this.snapshot(roomId, credential);
    }

    async rename(roomId: string, credential: string, name: string): Promise<RoomEvent> {
        return this.applyOne(renameRoom(await this.view(roomId), await hashCredential(credential), name, this.ctx()));
    }

    async setJoinPolicy(roomId: string, credential: string, joinPolicy: 'invite_only' | 'open_to_guests'): Promise<RoomEvent> {
        return this.applyOne(setJoinPolicy(await this.view(roomId), await hashCredential(credential), joinPolicy, this.ctx()));
    }

    async setInviteRole(roomId: string, credential: string, inviteRole: 'member' | 'guest'): Promise<RoomEvent> {
        return this.applyOne(setInviteRole(await this.view(roomId), await hashCredential(credential), inviteRole, this.ctx()));
    }

    async setLocalJoin(roomId: string, credential: string, localJoin: boolean): Promise<RoomEvent> {
        return this.applyOne(setLocalJoin(await this.view(roomId), await hashCredential(credential), localJoin, this.ctx()));
    }

    /** Guest entry. Knowing the room id is the entire claim, so the room must allow it. */
    async joinAsGuest(roomId: string, input: GuestJoinInput): Promise<RedeemResult> {
        return this.joinWithoutInvite(roomId, input, joinAsGuest);
    }

    /**
     * Member entry by name from the relay's local network or tailnet. Only call this
     * once the transport has established where the request came from; the room
     * itself must also allow it.
     */
    async joinOnLocalNetwork(roomId: string, input: GuestJoinInput): Promise<RedeemResult> {
        return this.joinWithoutInvite(roomId, input, joinOnLocalNetwork);
    }

    /** A retry with the same credential gets its original membership back instead of a second one. */
    private async joinWithoutInvite(roomId: string, input: GuestJoinInput, admit: typeof joinAsGuest): Promise<RedeemResult> {
        const view = await this.view(roomId);
        assertRoomJoinable(view, this.now());
        const credentialHash = await hashCredential(input.participantCredential);
        const existing = await this.store.participantByCredential(roomId, credentialHash);
        if (existing) {
            authenticate(view, credentialHash, this.now());
            return {roomId, participantId: existing.participantId, role: existing.role, replayed: true, snapshot: toSnapshot(view)};
        }

        const joined = admit(
            view,
            {
                credentialHash,
                displayName: input.displayName,
                kind: input.kind,
                nameSource: input.nameSource,
                sessionId: input.sessionId ?? null,
                capabilities: input.capabilities ?? null
            },
            this.ctx()
        );
        await this.store.apply(joined.mutation, null);
        return {roomId, participantId: joined.participant.participantId, role: joined.participant.role, replayed: false, snapshot: toSnapshot(await this.view(roomId))};
    }

    async setExpiry(roomId: string, credential: string, expiresAt: number | null): Promise<RoomEvent> {
        return this.applyOne(setExpiry(await this.view(roomId), await hashCredential(credential), expiresAt, this.ctx()));
    }

    async setAutoClose(roomId: string, credential: string, autoClose: AutoClosePolicy): Promise<RoomEvent> {
        const event = await this.applyOne(setAutoClose(await this.view(roomId), await hashCredential(credential), autoClose, this.ctx()));
        // A policy that is already overdue closes the room now rather than at the next request.
        await this.store.loadRoom(roomId);
        return event;
    }

    /**
     * Closes rooms whose deadline has passed, in a bounded batch. Returns how many
     * closed and the next deadline, so a scheduler can wake once, at the earliest.
     */
    async closeDueRooms(limit = 50): Promise<AutoCloseSweep> {
        const due = await this.store.dueAutoCloses(this.now(), limit);
        let closed = 0;
        for (const roomId of due) {
            if ((await this.store.loadRoom(roomId))?.room.lifecycle === 'closed') {
                closed++;
            }
        }
        return {closed, more: due.length === limit, nextAt: await this.store.nextAutoCloseAt()};
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
        const events = await Promise.all(page.events.map((event) => this.restoreAudience(event)));
        return {events, earliestSeq: view.earliestSeq, latestSeq: view.room.nextSeq - 1, hasMore: page.hasMore};
    }

    /** Older group events kept the all flag only in their canonical idempotency request. */
    private async restoreAudience(event: RoomEvent): Promise<RoomEvent> {
        if (!event.recipientIds || event.allRecipients !== undefined || !event.idempotencyKey) {
            return event;
        }
        const record = await this.store.idempotencyRecord(event.roomId, event.idempotencyKey);
        if (!record) {
            return event;
        }
        try {
            const request = JSON.parse(record.requestDigest) as Record<string, unknown>;
            return {...event, allRecipients: request['allRecipients'] === true};
        } catch {
            // Unknown historical metadata must not be guessed from today's membership.
            return event;
        }
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

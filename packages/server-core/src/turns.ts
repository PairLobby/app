import {ACK_TIMEOUT_MS, ProtocolError, TURN_LEASE_MS, hashCredential, newCredential, newId} from '@pairlobby/protocol';
import type {MessageRequest, TurnAction, TurnGrant, TurnMode, TurnQueue} from '@pairlobby/protocol';
import {appendEvent, assertCanWrite, assertController, assertRoomWritable, authenticate, emptyMutation} from '@pairlobby/room-core';
import type {Actor, RoomView} from '@pairlobby/room-core';
import type {RoomStore} from './store.js';

type TurnChange = 'claimed' | 'working' | 'passed' | 'skipped' | 'cancelled' | 'mode';

export function assertTurn(request: MessageRequest, token: string | undefined, now: number): void {
    if (!request.turnRequired) {
        return;
    }
    if (request.turnStatus !== 'running' || !token || request.turnToken !== token) {
        throw new ProtocolError('turn_required', 'this reply requires the current speaking turn');
    }
    if ((request.turnExpiresAt ?? 0) <= now) {
        throw new ProtocolError('turn_expired', 'this speaking turn expired; the owner can skip or cancel it');
    }
}

export class TurnCoordinator {
    constructor(private readonly store: RoomStore, private readonly now: () => number) {}

    private async view(roomId: string): Promise<RoomView> {
        const view = await this.store.loadRoom(roomId);
        if (!view) {
            throw new ProtocolError('room_not_found', 'room not found');
        }
        return view;
    }

    private async pending(roomId: string): Promise<MessageRequest[]> {
        return (await this.store.messageRequests(roomId, 0, 1000)).requests.filter((request) => !request.failureAt && !request.responseEventId && request.requiresReply);
    }

    async resolve(roomId: string, requestId: string, participantId?: string): Promise<MessageRequest | null> {
        const direct = await this.store.messageRequest(roomId, requestId);
        if (direct) {
            return direct;
        }
        const group = await this.store.groupRequests(roomId, requestId);
        return group.find((request) => request.to === participantId) ?? null;
    }

    private eligible(view: RoomView, request: MessageRequest): boolean {
        const participant = view.participants.find((member) => member.participantId === request.to);
        return Boolean(participant && participant.kind === 'agent' && participant.leftAt === null && participant.revokedAt === null && participant.role !== 'guest' && !participant.muted && !view.controls.find((control) => control.targetParticipantId === participant.participantId)?.paused);
    }

    private async change(view: RoomView, actor: Actor, requests: MessageRequest[], action: TurnChange, mode = view.room.turnMode ?? 'sequential'): Promise<void> {
        const revision = view.room.turnRevision ?? 0;
        const roomState = {...view.room, turnRevision: revision + 1, turnChangedAt: this.now(), turnMode: mode};
        const {room, event} = appendEvent(roomState, {
            senderId: actor.kind === 'participant' ? actor.participant.participantId : null,
            idempotencyKey: null, recipientId: null, replyTo: null,
            body: {type: 'conversation.turn_changed', payload: {action, mode, requestIds: requests.map((request) => request.eventId), participantIds: requests.map((request) => request.to)}}
        }, {now: this.now(), newEventId: () => newId('event')});
        await this.store.apply({...emptyMutation(room, event), expectedTurnRevision: revision, upsertRequests: requests.map((request) => ({...request, turnRevision: revision + 1}))}, null);
    }

    async status(roomId: string, credential: string): Promise<TurnQueue> {
        const view = await this.view(roomId);
        authenticate(view, await hashCredential(credential), this.now());
        const pending = (await this.store.messageRequests(roomId, 0, 1000)).requests;
        const hasRunning = pending.some((request) => !request.failureAt && request.turnStatus === 'running');
        const next = pending.find((request) => !request.failureAt && this.eligible(view, request));
        return {
            mode: view.room.turnMode ?? 'sequential',
            entries: pending.filter((request) => request.turnRequired || view.participants.find((participant) => participant.participantId === request.to)?.kind === 'agent').map((request) => {
                const participant = view.participants.find((member) => member.participantId === request.to);
                const unavailable = !participant || participant.leftAt !== null || participant.revokedAt !== null;
                const paused = participant?.muted || view.controls.find((control) => control.targetParticipantId === request.to)?.paused;
                const overdue = !hasRunning && request.eventId === next?.eventId && this.now() - Math.max(request.at, view.room.turnChangedAt ?? 0) >= ACK_TIMEOUT_MS;
                return {
                    requestId: request.eventId, conversationId: request.conversationId ?? request.eventId,
                    participantId: request.to, name: participant?.displayName ?? request.to,
                    state: request.failureAt ? 'failed' : request.turnStatus === 'running' ? ((request.turnExpiresAt ?? 0) <= this.now() ? 'stalled' : 'answering') : unavailable ? 'unavailable' : paused ? 'paused' : overdue ? 'stalled' : 'waiting',
                    ...(request.workingAt !== undefined && !unavailable && !paused ? {workingAt: request.workingAt} : {}),
                    ...(participant?.capabilities?.runtime ? {runtime: participant.capabilities.runtime} : {}),
                    expiresAt: request.turnExpiresAt ?? null
                };
            })
        };
    }

    async claim(roomId: string, credential: string, requestId: string, claimId: string): Promise<TurnGrant> {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const view = await this.view(roomId);
                const actor = authenticate(view, await hashCredential(credential), this.now());
                const participant = assertCanWrite(actor);
                assertRoomWritable(view, this.now());
                const request = await this.resolve(roomId, requestId, participant.participantId);
                if (!request || request.to !== participant.participantId || participant.kind !== 'agent') {
                    throw new ProtocolError('unauthorized', 'only the addressed agent can claim this turn');
                }
                if (!request.requiresReply || request.responseEventId || request.failureAt || request.turnStatus === 'failed') {
                    return {state: 'finished'};
                }
                if (!this.eligible(view, request)) {
                    return {state: 'waiting'};
                }
                if (request.turnStatus === 'running') {
                    if ((request.turnExpiresAt ?? 0) <= this.now()) {
                        return {state: 'stalled'};
                    }
                    return request.turnClaimId === claimId ? this.grant(view, request) : {state: 'waiting'};
                }
                const pending = await this.pending(roomId);
                if ((view.room.turnMode ?? 'sequential') === 'sequential') {
                    if (pending.some((entry) => entry.turnStatus === 'running')) {
                        return {state: 'waiting'};
                    }
                    if (pending.find((entry) => this.eligible(view, entry))?.eventId !== request.eventId) {
                        return {state: 'waiting'};
                    }
                }
                const next: MessageRequest = {...request, turnRequired: true, turnStatus: 'running', turnClaimId: claimId, turnToken: newCredential('attempt'), turnExpiresAt: this.now() + TURN_LEASE_MS};
                await this.change(view, actor, [next], 'claimed');
                return this.grant(view, next);
            } catch (error) {
                if (!(error instanceof ProtocolError) || error.code !== 'turn_conflict' || attempt === 3) {
                    throw error;
                }
            }
        }
        return {state: 'waiting'};
    }

    private async grant(view: RoomView, request: MessageRequest): Promise<TurnGrant> {
        let text = request.text;
        if (request.conversationId) {
            const previous = (await this.store.groupRequests(request.roomId, request.conversationId)).filter((entry) => entry.eventId !== request.eventId && (entry.responseEventId || ['passed', 'skipped', 'cancelled'].includes(entry.turnStatus ?? '')));
            let remaining = 24_000;
            const replies = previous.map((entry) => {
                const response = entry.responseText?.slice(0, Math.min(4000, remaining)) ?? '';
                remaining -= response.length;
                return {name: view.participants.find((participant) => participant.participantId === entry.to)?.displayName ?? entry.to, status: entry.turnStatus ?? 'answered', text: response, shortened: response.length < (entry.responseText?.length ?? 0)};
            });
            text += '\n\nThis is a group conversation. Take your turn, consider earlier replies, and add your own useful answer. You may use the pass tool if you have nothing to add. Earlier replies (up to 4,000 characters each and 24,000 total; shortened entries are labelled):\n' + JSON.stringify(replies);
        }
        return {state: 'granted', token: request.turnToken!, expiresAt: request.turnExpiresAt!, request: {...request, text}};
    }

    async working(roomId: string, credential: string, requestId: string, token: string): Promise<void> {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                return await this.declareWorking(roomId, credential, requestId, token);
            } catch (error) {
                if (!(error instanceof ProtocolError) || error.code !== 'turn_conflict' || attempt === 3) {
                    throw error;
                }
            }
        }
    }

    private async declareWorking(roomId: string, credential: string, requestId: string, token: string): Promise<void> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        const participant = assertCanWrite(actor);
        assertRoomWritable(view, this.now());
        const request = await this.resolve(roomId, requestId, participant.participantId);
        if (!request || request.to !== participant.participantId || participant.kind !== 'agent') {
            throw new ProtocolError('unauthorized', 'only the addressed agent can declare working');
        }
        if (!request.turnRequired || !request.requiresReply || request.responseEventId || request.failureAt || !this.eligible(view, request)) {
            throw new ProtocolError('turn_required', 'working requires a live, unfinished speaking turn');
        }
        assertTurn(request, token, this.now());
        if (request.receivedAt === null) {
            throw new ProtocolError('invalid_request', 'acknowledge the request before declaring work');
        }
        if (request.workingAt !== undefined) {
            return;
        }
        await this.change(view, actor, [{...request, workingAt: this.now()}], 'working');
    }

    async renew(roomId: string, credential: string, requestId: string, token: string): Promise<TurnGrant> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        const participant = assertCanWrite(actor);
        assertRoomWritable(view, this.now());
        const request = await this.resolve(roomId, requestId, participant.participantId);
        if (!request || request.to !== participant.participantId) {
            throw new ProtocolError('unauthorized', 'this turn belongs to another participant');
        }
        if (!request.turnRequired) {
            throw new ProtocolError('turn_required', 'claim the speaking turn first');
        }
        assertTurn(request, token, this.now());
        const revision = view.room.turnRevision ?? 0;
        const next = {...request, turnExpiresAt: this.now() + TURN_LEASE_MS, turnRevision: revision + 1};
        await this.store.updateTurns({...view.room, turnRevision: revision + 1}, [next], revision);
        return {state: 'granted', token, expiresAt: next.turnExpiresAt};
    }

    async pass(roomId: string, credential: string, requestId: string, token: string): Promise<void> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        assertRoomWritable(view, this.now());
        const participant = assertCanWrite(actor);
        const request = await this.resolve(roomId, requestId, participant.participantId);
        if (!request || request.to !== participant.participantId) {
            throw new ProtocolError('unauthorized', 'this turn belongs to another participant');
        }
        if (request.turnStatus === 'passed') {
            return;
        }
        if (!request.turnRequired) {
            throw new ProtocolError('turn_required', 'claim the speaking turn first');
        }
        assertTurn(request, token, this.now());
        await this.change(view, actor, [{...request, requiresReply: false, turnStatus: 'passed', turnToken: '', turnExpiresAt: 0}], 'passed');
    }

    async mode(roomId: string, credential: string, mode: TurnMode): Promise<TurnQueue> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        assertController(actor);
        if (mode === 'sequential' && (await this.pending(roomId)).filter((request) => request.turnStatus === 'running').length > 1) {
            throw new ProtocolError('turn_conflict', 'wait for the active parallel turns to finish or cancel them first');
        }
        await this.change(view, actor, [], 'mode', mode);
        return this.status(roomId, credential);
    }

    async control(roomId: string, credential: string, action: TurnAction): Promise<TurnQueue> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        assertController(actor);
        const pending = (await this.store.messageRequests(roomId, 0, 1000)).requests;
        const chosen = action.requestId
            ? pending.find((request) => request.eventId === action.requestId || request.conversationId === action.requestId)
            : action.participantId ? pending.find((request) => request.to === action.participantId) : pending.find((request) => request.turnStatus === 'running') ?? pending.find((request) => !request.failureAt && this.eligible(view, request)) ?? pending.find((request) => request.turnRequired);
        if (!chosen) {
            throw new ProtocolError('invalid_request', 'no matching pending turn');
        }
        const selected = action.action === 'cancel' && chosen.conversationId ? pending.filter((request) => request.conversationId === chosen.conversationId) : [chosen];
        const turnStatus = action.action === 'skip' ? 'skipped' : 'cancelled';
        await this.change(view, actor, selected.map((request) => ({...request, requiresReply: false, turnStatus, turnToken: '', turnExpiresAt: 0})), turnStatus);
        return this.status(roomId, credential);
    }
}

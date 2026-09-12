//! A deterministic stand-in for an agent runtime. It validates the harness and
//! the protocol; it is never evidence that a real provider behaves this way.

import {newId} from '@pairlobby/protocol';
import type {AdapterCapabilities, ControlOutcome, HandoverDocument, RoomEvent} from '@pairlobby/protocol';

import type {RoomHarness} from './harness.js';

export interface FakeAgentOptions {
    /** What this fake claims its adapter can do. Real capabilities come from the provider spike, not from here. */
    capabilities?: AdapterCapabilities;
    /** Outcome the fake reports when the controller pauses it. */
    pauseOutcome?: ControlOutcome;
}

export class FakeAgent {
    readonly displayName: string;
    readonly sessionId: string;
    participantId = '';
    credential = '';
    cursor = 0;
    paused = false;
    readonly inbox: RoomEvent[] = [];
    readonly seen = new Set<string>();
    private readonly server: RoomHarness;
    private readonly options: FakeAgentOptions;

    constructor(server: RoomHarness, displayName: string, options: FakeAgentOptions = {}) {
        this.server = server;
        this.displayName = displayName;
        this.sessionId = newId('session');
        this.options = options;
    }

    private identity() {
        return {displayName: this.displayName, kind: 'agent' as const, sessionId: this.sessionId, ...(this.options.capabilities ? {capabilities: this.options.capabilities} : {})};
    }

    async create(roomName: string): Promise<{controllerCredential: string; inviteCode: string}> {
        const created = await this.server.createRoom(roomName, this.identity());
        this.participantId = created.participantId;
        this.credential = created.participantCredential;
        return {controllerCredential: created.controllerCredential, inviteCode: created.inviteCode};
    }

    async join(code: string): Promise<void> {
        this.credential = `plp_${newId('room')}`;
        const redeemed = await this.server.redeemInvite(code, this.identity(), newId('attempt'), this.credential);
        this.participantId = redeemed.participantId;
    }

    async say(text: string, recipientId?: string): Promise<RoomEvent> {
        const result = await this.server.send(this.credential, {type: 'message', payload: {text, priority: 'normal'}, idempotencyKey: newId('event'), ...(recipientId ? {recipientId} : {})});
        return result.event;
    }

    async offerHandover(recipientId: string, document: HandoverDocument, handoverId = newId('handover'), revision = 1): Promise<string> {
        await this.server.send(this.credential, {type: 'handover.offered', payload: {handoverId, revision, document}, idempotencyKey: newId('event'), recipientId});
        return handoverId;
    }

    async acceptHandover(handoverId: string, revision: number): Promise<void> {
        await this.server.send(this.credential, {type: 'handover.accepted', payload: {handoverId, revision}, idempotencyKey: newId('event')});
    }

    async declineHandover(handoverId: string, revision: number, reason?: string): Promise<void> {
        await this.server.send(this.credential, {type: 'handover.declined', payload: {handoverId, revision, ...(reason ? {reason} : {})}, idempotencyKey: newId('event')});
    }

    /**
     * Reads new events and, by default, activates only on events addressed to
     * this agent. Room-wide chatter does not wake every participant.
     */
    async poll(): Promise<RoomEvent[]> {
        const page = await this.server.read(this.credential, this.cursor);
        this.cursor = page.events.at(-1)?.seq ?? this.cursor;
        const fresh = page.events.filter((event) => !this.seen.has(event.eventId));
        for (const event of fresh) this.seen.add(event.eventId);
        for (const event of fresh) {
            if (event.type === 'control.pause' && event.payload.targetParticipantId === this.participantId) await this.handlePause(event.payload.revision);
            if (event.type === 'control.resume' && event.payload.targetParticipantId === this.participantId) await this.handleResume(event.payload.revision);
        }
        const addressed = fresh.filter((event) => event.recipientId === this.participantId);
        this.inbox.push(...addressed);
        return addressed;
    }

    private async handlePause(revision: number): Promise<void> {
        this.paused = true;
        const outcome = this.options.pauseOutcome ?? (this.options.capabilities?.cancelTurn ? 'current_turn_cancelled' : 'paused_between_turns');
        await this.server.send(this.credential, {type: 'control.ack', payload: {targetParticipantId: this.participantId, revision, outcome}, idempotencyKey: newId('event')});
    }

    private async handleResume(revision: number): Promise<void> {
        this.paused = false;
        await this.server.send(this.credential, {type: 'control.ack', payload: {targetParticipantId: this.participantId, revision, outcome: 'resumed'}, idempotencyKey: newId('event')});
    }
}

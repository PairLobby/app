//! Receipt watermarks over real HTTP, in each receipt mode: a plain receipt moves one
//! number per participant instead of adding an event, request states stay what they were,
//! and read and action stages stay events.

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {newCredential, newId} from '@pairlobby/protocol';
import type {MessageRequest, ReadEventsResponse, ReceiptMode, RoomEvent} from '@pairlobby/protocol';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';

import {startServer, type RunningServer} from '../src/server.js';
import {SqliteRoomStore} from '../src/sqlite-store.js';

type Member = {participantId: string; credential: string};
type Room = {roomId: string; owner: Member};
type Relay = {server: RunningServer; call: (path: string, init?: RequestInit & {credential?: string}) => Promise<Response>};

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-receipts-'));
const relays = new Map<ReceiptMode, Relay>();

beforeAll(async () => {
    for (const mode of ['events', 'both', 'watermark'] as const) {
        const server = await startServer({port: 0, dataFile: join(directory, `${mode}.sqlite`), receiptMode: mode});
        relays.set(mode, {server, call: caller(server)});
    }
});

afterAll(async () => {
    await Promise.all([...relays.values()].map((relay) => relay.server.close()));
    rmSync(directory, {recursive: true, force: true});
});

function caller(server: RunningServer): Relay['call'] {
    return (path, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set('content-type', 'application/json');
        if (init.credential) {
            headers.set('authorization', `Bearer ${init.credential}`);
        }
        return fetch(`${server.url}${path}`, {...init, headers});
    };
}

function relay(mode: ReceiptMode): Relay {
    return relays.get(mode)!;
}

async function body<T>(response: Response, status = 200): Promise<T> {
    const text = await response.text();
    expect(response.status, text).toBe(status);
    return (text ? JSON.parse(text) : null) as T;
}

async function createRoom({call}: Relay): Promise<Room> {
    const credential = newCredential('participant');
    const created = await body<{room: {roomId: string}; participantId: string}>(await call('/v1/rooms', {method: 'POST', body: JSON.stringify({name: 'receipts', displayName: 'owner', kind: 'human', controllerCredential: newCredential('controller'), participantCredential: credential})}), 201);
    return {roomId: created.room.roomId, owner: {participantId: created.participantId, credential}};
}

/** A code seats one participant at a time, so each one gets its own. */
async function enter({call}: Relay, room: Room, name: string): Promise<Member> {
    const invite = await body<{code: string}>(await call(`/v1/rooms/${room.roomId}/invites`, {method: 'POST', credential: room.owner.credential, body: '{}'}), 201);
    const credential = newCredential('participant');
    const joined = await body<{participantId: string}>(await call('/v1/invites/redeem', {method: 'POST', body: JSON.stringify({code: invite.code, displayName: name, kind: 'agent', attemptId: newId('attempt'), attemptSecret: newCredential('attempt'), participantCredential: credential})}));
    return {participantId: joined.participantId, credential};
}

async function say({call}: Relay, room: Room, from: Member, text: string, to?: Member): Promise<RoomEvent> {
    const sent = await body<{event: RoomEvent}>(await call(`/v1/rooms/${room.roomId}/events`, {method: 'POST', credential: from.credential, body: JSON.stringify({type: 'message', payload: {text, priority: 'normal'}, idempotencyKey: newId('event'), ...(to ? {recipientId: to.participantId} : {})})}), 201);
    return sent.event;
}

function read({call}: Relay, room: Room, member: Member, query = ''): Promise<ReadEventsResponse> {
    return call(`/v1/rooms/${room.roomId}/events?after=0&limit=500${query}`, {credential: member.credential}).then((response) => body<ReadEventsResponse>(response));
}

function ack({call}: Relay, room: Room, member: Member, event: RoomEvent): Promise<MessageRequest | null> {
    return call(`/v1/rooms/${room.roomId}/requests/${event.eventId}/ack`, {method: 'POST', credential: member.credential, body: '{}'}).then((response) => body<MessageRequest | null>(response));
}

function receipt({call}: Relay, room: Room, member: Member, throughSeq: number): Promise<Response> {
    return call(`/v1/rooms/${room.roomId}/receipts`, {method: 'POST', credential: member.credential, body: JSON.stringify({throughSeq})});
}

function request({call}: Relay, room: Room, member: Member, event: RoomEvent): Promise<MessageRequest> {
    return call(`/v1/rooms/${room.roomId}/requests/${event.eventId}`, {credential: member.credential}).then((response) => body<MessageRequest>(response));
}

const receivedEvents = (page: ReadEventsResponse) => page.events.filter((event) => event.type === 'message.received');

describe('receipt modes as the relay describes them', () => {
    test('test_each_mode_is_described_and_only_events_mode_refuses_watermarks', async () => {
        for (const mode of ['events', 'both', 'watermark'] as const) {
            const described = await body<{features: string[]; receiptMode: string}>(await relay(mode).call('/v1/server'));
            expect(described.receiptMode).toBe(mode);
            expect(described.features.includes('receipt-watermark')).toBe(mode !== 'events');
        }
        const events = relay('events');
        const room = await createRoom(events);
        const agent = await enter(events, room, 'agent');
        const refused = await receipt(events, room, agent, 1);
        expect(refused.status).toBe(501);
        expect(((await refused.json()) as {error: {code: string}}).error.code).toBe('unsupported_capability');
        expect((await read(events, room, agent, '&receiptsAfter=0')).receipts).toBeUndefined();
    });
});

describe('receipts in both mode', () => {
    test('test_a_plain_receipt_is_still_an_event_and_also_moves_the_watermark', async () => {
        const both = relay('both');
        const room = await createRoom(both);
        const agent = await enter(both, room, 'agent');
        const said = await say(both, room, room.owner, 'hello room');
        await ack(both, room, agent, said);
        const page = await read(both, room, room.owner, '&receiptsAfter=0');
        expect(receivedEvents(page).map((event) => event.senderId)).toEqual([agent.participantId]);
        expect(page.receipts).toEqual([expect.objectContaining({participantId: agent.participantId, throughSeq: said.seq, revision: 1})]);
        expect(page.receiptRevision).toBe(1);
    });

    test('test_an_addressed_receipt_marks_its_request_without_claiming_earlier_messages', async () => {
        const both = relay('both');
        const room = await createRoom(both);
        const agent = await enter(both, room, 'agent');
        await say(both, room, room.owner, 'for everyone');
        const asked = await say(both, room, room.owner, 'please look', agent);
        await ack(both, room, agent, asked);
        expect((await request(both, room, room.owner, asked)).receivedAt).not.toBeNull();
        expect((await read(both, room, room.owner, '&receiptsAfter=0')).receipts).toEqual([]);
    });
});

describe('receipts in watermark mode', () => {
    test('test_a_message_costs_one_event_however_many_members_receive_it', async () => {
        const watermark = relay('watermark');
        const room = await createRoom(watermark);
        const agents = [];
        for (let index = 0; index < 4; index++) {
            agents.push(await enter(watermark, room, `agent-${index}`));
        }
        const before = (await read(watermark, room, room.owner)).latestSeq;
        const said = await say(watermark, room, room.owner, 'hello all');
        for (const agent of agents) {
            await ack(watermark, room, agent, said);
        }
        const page = await read(watermark, room, room.owner, '&receiptsAfter=0');
        expect(page.latestSeq).toBe(before + 1);
        expect(receivedEvents(page)).toEqual([]);
        expect(page.receipts?.map((mark) => mark.participantId).sort()).toEqual(agents.map((agent) => agent.participantId).sort());
        expect(page.receipts?.every((mark) => mark.throughSeq === said.seq)).toBe(true);
    });

    test('test_an_older_clients_plain_receipt_event_is_answered_as_before_without_an_event', async () => {
        const watermark = relay('watermark');
        const room = await createRoom(watermark);
        const agent = await enter(watermark, room, 'old-agent');
        const said = await say(watermark, room, room.owner, 'hello');
        const response = await watermark.call(`/v1/rooms/${room.roomId}/events`, {method: 'POST', credential: agent.credential, body: JSON.stringify({type: 'message.received', payload: {eventId: said.eventId}, idempotencyKey: newId('event')})});
        const answered = await body<{event: RoomEvent; deduplicated: boolean}>(response);
        expect(answered.deduplicated).toBe(true);
        expect(answered.event.type).toBe('message.received');
        const page = await read(watermark, room, room.owner, '&receiptsAfter=0');
        expect(page.latestSeq).toBe(said.seq);
        expect(page.receipts).toEqual([expect.objectContaining({participantId: agent.participantId, throughSeq: said.seq})]);
    });

    test('test_read_and_action_stages_stay_events', async () => {
        const watermark = relay('watermark');
        const room = await createRoom(watermark);
        const agent = await enter(watermark, room, 'agent');
        const asked = await say(watermark, room, room.owner, 'please read', agent);
        await ack(watermark, room, agent, asked);
        await body(await watermark.call(`/v1/rooms/${room.roomId}/events`, {method: 'POST', credential: agent.credential, body: JSON.stringify({type: 'message.received', payload: {eventId: asked.eventId, stage: 'read'}, idempotencyKey: newId('event')})}), 201);
        const stages = receivedEvents(await read(watermark, room, room.owner));
        expect(stages.map((event) => event.type === 'message.received' && event.payload.stage)).toEqual(['read']);
        const state = await request(watermark, room, room.owner, asked);
        expect(state.receivedAt).not.toBeNull();
        expect(state.readAt).not.toBeUndefined();
    });

    test('test_a_watermark_marks_requests_up_to_it_received_and_leaves_later_ones', async () => {
        const watermark = relay('watermark');
        const room = await createRoom(watermark);
        const agent = await enter(watermark, room, 'agent');
        const first = await say(watermark, room, room.owner, 'first', agent);
        const second = await say(watermark, room, room.owner, 'second', agent);
        const third = await say(watermark, room, room.owner, 'third', agent);
        const moved = await body<{throughSeq: number; receiptRevision: number}>(await receipt(watermark, room, agent, second.seq));
        expect(moved.throughSeq).toBe(second.seq);
        expect((await request(watermark, room, room.owner, first)).receivedAt).not.toBeNull();
        expect((await request(watermark, room, room.owner, second)).receivedAt).not.toBeNull();
        expect((await request(watermark, room, room.owner, third)).receivedAt).toBeNull();
        expect((await read(watermark, room, room.owner)).latestSeq).toBe(third.seq);
    });

    test('test_a_watermark_never_moves_back_or_past_the_last_event_and_reads_return_only_what_moved', async () => {
        const watermark = relay('watermark');
        const room = await createRoom(watermark);
        const first = await enter(watermark, room, 'first');
        const second = await enter(watermark, room, 'second');
        const said = await say(watermark, room, room.owner, 'hello');
        expect((await body<{throughSeq: number}>(await receipt(watermark, room, first, said.seq + 50))).throughSeq).toBe(said.seq);
        expect((await body<{throughSeq: number}>(await receipt(watermark, room, first, 1))).throughSeq).toBe(said.seq);
        const afterFirst = (await read(watermark, room, room.owner, '&receiptsAfter=0')).receiptRevision!;
        await receipt(watermark, room, second, said.seq);
        const changed = await read(watermark, room, room.owner, `&receiptsAfter=${afterFirst}`);
        expect(changed.receipts?.map((mark) => mark.participantId)).toEqual([second.participantId]);
        expect(changed.receiptRevision).toBe(afterFirst + 1);
    });

    test('test_watermarks_never_count_against_the_retained_event_limits', async () => {
        const watermark = relay('watermark');
        const room = await createRoom(watermark);
        const agent = await enter(watermark, room, 'agent');
        const said = await say(watermark, room, room.owner, 'hello');
        const store = new SqliteRoomStore(join(directory, 'watermark.sqlite'));
        try {
            const before = (await store.loadRoom(room.roomId))!.room;
            await receipt(watermark, room, agent, said.seq);
            const after = (await store.loadRoom(room.roomId))!.room;
            expect(after.receipts?.[agent.participantId]?.throughSeq).toBe(said.seq);
            expect([after.retainedEvents, after.retainedEventBytes, after.nextSeq]).toEqual([before.retainedEvents, before.retainedEventBytes, before.nextSeq]);
        } finally {
            store.close();
        }
    });

    test('test_a_waiting_read_that_asks_for_receipts_answers_when_a_watermark_moves', async () => {
        const watermark = relay('watermark');
        const room = await createRoom(watermark);
        const agent = await enter(watermark, room, 'agent');
        const said = await say(watermark, room, room.owner, 'hello');
        const started = Date.now();
        const held = watermark.call(`/v1/rooms/${room.roomId}/events?after=${said.seq}&wait=10000&receiptsAfter=0`, {credential: room.owner.credential}).then((response) => body<ReadEventsResponse>(response));
        await new Promise((resolve) => setTimeout(resolve, 100));
        await receipt(watermark, room, agent, said.seq);
        const page = await held;
        expect(Date.now() - started).toBeLessThan(5000);
        expect(page.events).toEqual([]);
        expect(page.receipts?.map((mark) => mark.participantId)).toEqual([agent.participantId]);
    });
});

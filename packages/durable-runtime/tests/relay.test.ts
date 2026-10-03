import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {createTestHarness} from 'wrangler';
import {PairLobbyClient} from '@pairlobby/client';
import {ProtocolError, newId} from '@pairlobby/protocol';

const harness = createTestHarness({workers: [{configPath: 'packages/durable-runtime/wrangler.jsonc'}]});
let base: string;

beforeAll(async () => {
    base = (await harness.listen()).url.toString();
}, 60_000);

afterAll(async () => {
    await harness.close();
});

const human = {displayName: 'Ada', kind: 'human' as const};
const agent = {displayName: 'claude-backend', kind: 'agent' as const};

describe('standalone durable relay', () => {
    test('test_health_answers', async () => {
        const response = await fetch(new URL('/health', base));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({service: 'pairlobby-relay', ready: true});
    });

    test('test_create_redeem_send_and_read_across_room_objects', async () => {
        const owner = new PairLobbyClient(base);
        const guest = new PairLobbyClient(base);
        const room = await owner.createRoom('relay', human);
        const joined = await guest.redeemInvite(room.invite.code, agent);
        expect(joined.roomId).toBe(room.roomId);
        const sent = await owner.send(room.roomId, room.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'Please review', priority: 'normal'}, idempotencyKey: newId('event')});
        const page = await guest.readEvents(joined.roomId, joined.participantCredential, 0);
        expect(page.events.some((event) => event.eventId === sent.event.eventId)).toBe(true);
        const pending = await guest.pendingRequests(joined.roomId, joined.participantCredential, joined.participantId);
        expect(pending.map((request) => request.eventId)).toContain(sent.event.eventId);
    });

    test('test_rooms_are_isolated_from_each_other', async () => {
        const client = new PairLobbyClient(base);
        const first = await client.createRoom('first', human);
        const second = await client.createRoom('second', human);
        expect(first.roomId).not.toBe(second.roomId);
        await expect(client.snapshot(second.roomId, first.participantCredential)).rejects.toBeInstanceOf(ProtocolError);
    });

    test('test_reusable_invite_minted_later_is_redeemable', async () => {
        const owner = new PairLobbyClient(base);
        const room = await owner.createRoom('minted', human);
        const minted = await owner.mintInvite(room.roomId, room.controllerCredential, 'member', true);
        const joined = await new PairLobbyClient(base).redeemInvite(minted.code, agent);
        expect(joined.roomId).toBe(room.roomId);
        expect(joined.role).toBe('member');
    });

    test('test_unknown_and_malformed_invites_are_refused', async () => {
        const client = new PairLobbyClient(base);
        await expect(client.redeemInvite('ZZZZ-ZZZZ', agent)).rejects.toMatchObject({code: 'invite_unknown'});
        await expect(client.redeemInvite('not a code', agent)).rejects.toMatchObject({code: 'invite_unknown'});
    });

    test('test_browser_origins_are_refused', async () => {
        const response = await fetch(new URL('/v1/rooms', base), {method: 'POST', headers: {origin: 'https://example.com', 'content-type': 'application/json'}, body: '{}'});
        expect(response.status).toBe(401);
    });

    test('test_caller_cannot_pick_the_room_id', async () => {
        const client = new PairLobbyClient(base);
        const room = await client.createRoom('owned', human);
        const response = await fetch(new URL('/v1/rooms', base), {method: 'POST', headers: {'content-type': 'application/json', 'x-pairlobby-room-id': room.roomId}, body: JSON.stringify({name: 'hijack', controllerCredential: 'c'.repeat(32), participantCredential: 'p'.repeat(32), ...human})});
        if (response.ok) {
            const body = await response.json() as {room: {roomId: string}};
            expect(body.room.roomId).not.toBe(room.roomId);
        }
        expect((await client.snapshot(room.roomId, room.participantCredential)).name).toBe('owned');
    });

    test('test_malformed_room_ids_and_unknown_paths_are_refused', async () => {
        expect((await fetch(new URL('/v1/rooms/not-a-room/snapshot', base))).status).toBe(404);
        expect((await fetch(new URL('/elsewhere', base))).status).toBe(404);
    });

    test('test_closed_room_stays_closed', async () => {
        const client = new PairLobbyClient(base);
        const room = await client.createRoom('closing', human);
        await client.close(room.roomId, room.controllerCredential);
        const snapshot = await client.snapshot(room.roomId, room.participantCredential);
        expect(snapshot.closedAt).not.toBeNull();
        await expect(client.redeemInvite(room.invite.code, agent)).rejects.toBeInstanceOf(ProtocolError);
    });

    test('test_receipt_pause_interrupt_export_and_delete', async () => {
        const owner = new PairLobbyClient(base);
        const guest = new PairLobbyClient(base);
        const room = await owner.createRoom('lifecycle', human);
        const joined = await guest.redeemInvite(room.invite.code, agent);
        const sent = await owner.send(room.roomId, room.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'Please review', priority: 'normal'}, idempotencyKey: newId('event')});

        await guest.reportMessageStatus(joined.roomId, joined.participantCredential, sent.event.eventId, 'read');
        expect((await owner.request(room.roomId, room.participantCredential, sent.event.eventId)).readAt).toBeTypeOf('number');

        const paused = await owner.control(room.roomId, room.controllerCredential, joined.participantId, true);
        expect((await owner.snapshot(room.roomId, room.participantCredential)).participants.find((participant) => participant.participantId === joined.participantId)?.paused).toBe(true);
        await owner.control(room.roomId, room.controllerCredential, joined.participantId, false);
        const interrupted = await owner.interrupt(room.roomId, room.controllerCredential, joined.participantId);
        expect(interrupted.revision).toBeGreaterThan(paused.revision);

        const exported = await owner.export(room.roomId, room.controllerCredential);
        expect(exported.room.roomId).toBe(room.roomId);
        expect(exported.events.some((event) => event.eventId === sent.event.eventId)).toBe(true);

        await owner.delete(room.roomId, room.controllerCredential);
        await expect(guest.snapshot(joined.roomId, joined.participantCredential)).rejects.toBeInstanceOf(ProtocolError);
    });
});

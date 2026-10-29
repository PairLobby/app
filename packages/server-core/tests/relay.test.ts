import {hashCredential, newId, newInviteCode, normalizeInviteCode} from '@pairlobby/protocol';
import {describe, expect, test} from 'vitest';

import {CREATE_TOKEN_HEADER, createAdmission, memoryRateLimiter} from '../src/admission.js';
import {queueExecutor, timerScheduler} from '../src/ports.js';
import {createRelay} from '../src/relay.js';
import type {RelayOptions, RoomRoute} from '../src/relay.js';
import type {AutoCloseSweep, RoomService} from '../src/service.js';

type StubState = {invites: Map<string, string>; sweep: AutoCloseSweep; sweeps: number};

/** Only what `edge` and `tick` touch: anything in a room would need a real store, which the Node relay's tests use. */
function stubService(state: StubState): RoomService {
    return {
        relayProfile: () => ({files: false, limits: {maxParticipants: 8}}),
        inviteRoom: async (digest: string) => state.invites.get(digest) ?? null,
        closeDueRooms: async () => {
            state.sweeps++;
            return state.sweep;
        }
    } as unknown as RoomService;
}

function stub(): StubState {
    return {invites: new Map(), sweep: {closed: 0, more: false, nextAt: null}, sweeps: 0};
}

function relayWith(state: StubState, options: Partial<RelayOptions> = {}) {
    return createRelay({service: stubService(state), ...options});
}

function routed(result: Response | RoomRoute): RoomRoute {
    expect(result).not.toBeInstanceOf(Response);
    return result as RoomRoute;
}

function redeem(code: string, headers: Record<string, string> = {}): Request {
    const body = {displayName: 'joiner', kind: 'agent', code, attemptId: newId('attempt'), attemptSecret: 's'.repeat(32), participantCredential: 'p'.repeat(32)};
    return new Request('http://relay/v1/invites/redeem', {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
}

function create(headers: Record<string, string> = {}): Request {
    return new Request('http://relay/v1/rooms', {method: 'POST', headers, body: '{}'});
}

describe('relay kernel edge', () => {
    test('test_the_edge_answers_what_needs_no_room_and_names_the_room_for_the_rest', async () => {
        const relay = relayWith(stub());
        const described = await relay.edge(new Request('http://relay/v1/server'));
        expect(described).toBeInstanceOf(Response);
        expect(((await (described as Response).json()) as {features: string[]}).features).toContain('message-stages');
        expect(routed(await relay.edge(new Request('http://relay/v1/rooms/rm_ABC/events'))).roomId).toBe('rm_ABC');
        expect(((await relay.edge(new Request('http://relay/elsewhere'))) as Response).status).toBe(404);
        const refused = await relay.edge(new Request('http://relay/v1/server', {headers: {origin: 'https://page.example.com'}}));
        expect((refused as Response).status).toBe(401);
    });

    test('test_a_new_room_gets_a_fresh_id_at_the_edge_only_with_the_create_token', async () => {
        const relay = relayWith(stub(), {admission: createAdmission({createToken: 'team-secret'})});
        const refused = (await relay.edge(create())) as Response;
        expect(refused.status).toBe(401);
        const first = routed(await relay.edge(create({[CREATE_TOKEN_HEADER]: 'team-secret'})));
        const second = routed(await relay.edge(create({[CREATE_TOKEN_HEADER]: 'team-secret'})));
        expect(first.roomId).toMatch(/^rm_/);
        expect(first.roomId).not.toBe(second.roomId);
    });

    test('test_an_invite_code_is_routed_by_its_digest_and_the_room_still_gets_the_body', async () => {
        const state = stub();
        const code = newInviteCode();
        state.invites.set(await hashCredential(normalizeInviteCode(code)!), 'rm_INVITED');
        const relay = relayWith(state);
        const route = routed(await relay.edge(redeem(code.toLowerCase())));
        expect(route.roomId).toBe('rm_INVITED');
        expect(((await route.request.json()) as {code: string}).code).toBe(code.toLowerCase());
        const unknown = (await relay.edge(redeem(newInviteCode()))) as Response;
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toMatchObject({error: {code: 'invite_unknown', message: 'that invite code is not valid'}});
        const malformed = (await relay.edge(redeem('nope'))) as Response;
        expect(await malformed.json()).toMatchObject({error: {code: 'invite_unknown', message: 'that invite code is not well formed'}});
    });

    test('test_joining_by_name_needs_a_local_peer_and_is_refused_behind_a_proxy', async () => {
        const roomId = newId('room');
        const join = () => new Request(`http://relay/v1/rooms/${roomId}/local-join`, {method: 'POST', body: '{}'});
        const local = {peerIsLocal: () => true, localRooms: async () => []};
        expect(routed(await relayWith(stub(), local).edge(join())).roomId).toBe(roomId);
        expect(((await relayWith(stub(), {peerIsLocal: () => false, localRooms: async () => []}).edge(join())) as Response).status).toBe(401);
        const proxied = relayWith(stub(), {...local, behindProxy: true});
        expect(((await proxied.edge(join())) as Response).status).toBe(401);
        const description = (await (await proxied.edge(new Request('http://relay/v1/server')) as Response).json()) as {features: string[]};
        expect(description.features).not.toContain('local-join');
    });

    test('test_a_forwarded_address_is_only_believed_from_a_trusted_proxy_header', async () => {
        const limits = {createPerMinutePerAddress: 1};
        const from = (address: string) => create({'x-forwarded-for': address});
        const direct = relayWith(stub(), {admission: createAdmission({limiter: memoryRateLimiter(), limits})});
        routed(await direct.edge(from('10.0.0.1'), {peerAddress: '203.0.113.9'}));
        expect(((await direct.edge(from('10.0.0.2'), {peerAddress: '203.0.113.9'})) as Response).status).toBe(429);
        const proxied = relayWith(stub(), {admission: createAdmission({limiter: memoryRateLimiter(), limits, trustedProxyHeader: 'x-forwarded-for'})});
        routed(await proxied.edge(from('10.0.0.1'), {peerAddress: '203.0.113.9'}));
        routed(await proxied.edge(from('10.0.0.2'), {peerAddress: '203.0.113.9'}));
    });
});

describe('relay kernel tick', () => {
    test('test_a_tick_closes_due_rooms_and_plans_the_next_wake_up', async () => {
        const state = stub();
        const planned: Array<number | null> = [];
        const relay = relayWith(state, {scheduler: {plan: (at) => planned.push(at)}});
        state.sweep = {closed: 1, more: false, nextAt: 5_000};
        await relay.tick('auto-close');
        state.sweep = {closed: 0, more: false, nextAt: null};
        await relay.tick('auto-close');
        expect(state.sweeps).toBe(2);
        expect(planned).toEqual([5_000, null]);
    });
});

describe('ports', () => {
    test('test_writes_run_one_at_a_time_and_a_read_waits_only_for_writes_queued_before_it', async () => {
        const executor = queueExecutor();
        const order: string[] = [];
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = executor.run('rm_A', true, async () => {
            await held;
            order.push('first write');
        });
        const read = executor.run('rm_A', false, async () => {
            order.push('read');
        });
        const second = executor.run('rm_A', true, async () => {
            order.push('second write');
        });
        release();
        await Promise.all([first, read, second, executor.idle()]);
        expect(order[0]).toBe('first write');
        expect(order.slice(1).sort()).toEqual(['read', 'second write']);
    });

    test('test_a_later_plan_replaces_an_earlier_one_and_stop_cancels_for_good', async () => {
        let woken = 0;
        const scheduler = timerScheduler(() => woken++);
        scheduler.plan(Date.now() + 60_000);
        scheduler.plan(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(woken).toBe(1);
        scheduler.stop();
        scheduler.plan(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(woken).toBe(1);
    });
});

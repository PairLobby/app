//! The agent directory's listings on the Node relay's store: sharing, heartbeats, the
//! refusals, and the sweep that deletes listings whose room or agent is gone.

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {LISTING_OFFLINE_AFTER_MS, hashCredential, listingAvailability, newCredential, newId, newInviteCode, normalizeInviteCode} from '@pairlobby/protocol';
import type {ListingRecord, ListingView, ParticipantOrigin} from '@pairlobby/protocol';
import {RoomService, createAdmission, createRelay, queueExecutor} from '@pairlobby/server-core';
import type {Relay} from '@pairlobby/server-core';
import {afterAll, describe, expect, test} from 'vitest';

import {issueMemberToken} from '../src/members.js';
import {startServer} from '../src/server.js';
import {SqliteRoomStore} from '../src/sqlite-store.js';

type Fixture = {relay: Relay; store: SqliteRoomStore; service: RoomService; clock: {now: number}};

type Call = {status: number; listing?: ListingView; error?: {message: string}};

type CallOptions = {credential?: string; token?: string; body?: unknown};

type Joined = {roomId: string; controller: string; human: string; agent: string; agentId: string};

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-directory-'));

afterAll(() => {
    rmSync(directory, {recursive: true, force: true});
});

const DAMIEN = 'damien-token';
const HUGO = 'hugo-token';
const TEAM = 'team-token';

let counter = 0;

async function fixture(): Promise<Fixture> {
    counter += 1;
    const store = new SqliteRoomStore(join(directory, `directory-${counter}.sqlite`));
    const clock = {now: 1_000_000};
    const service = new RoomService(store, () => clock.now);
    const tokens = new Map([[await hashCredential(DAMIEN), {handle: 'damien'}], [await hashCredential(HUGO), {handle: 'hugo'}]]);
    const admission = createAdmission({createToken: TEAM, members: async (digest) => tokens.get(digest) ?? null});
    return {relay: createRelay({service, executor: queueExecutor(), admission, directory: store.directory}), store, service, clock};
}

async function call({relay}: Fixture, path: string, method: string, {credential, token, body}: CallOptions = {}): Promise<Call> {
    const headers: Record<string, string> = {'content-type': 'application/json', ...(credential ? {authorization: `Bearer ${credential}`} : {}), ...(token ? {'x-pairlobby-account-token': token} : {})};
    const response = await relay.handle(new Request(`http://relay/v1/directory/listings${path}`, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
    return {status: response.status, ...((await response.json().catch(() => ({}))) as {listing?: ListingView; error?: {message: string}})};
}

/** A room damien created, with an agent that joined it with his token. */
async function room({service}: Fixture, member = 'damien'): Promise<Joined> {
    const controller = newCredential('controller');
    const human = newCredential('participant');
    const agent = newCredential('participant');
    const created = await service.createRoom({name: 'payments', displayName: member, kind: 'human', controllerCredential: controller, participantCredential: human, owner: member, member});
    const joined = await service.redeemInvite({code: created.invite.code, displayName: 'backend-reviewer', kind: 'agent', participantCredential: agent, attemptId: newId('attempt'), member});
    return {roomId: created.roomId, controller, human, agent, agentId: joined.participantId};
}

function share(joined: Joined, topic = 'Payment reconciliation'): Record<string, unknown> {
    return {roomId: joined.roomId, topic, connection: 'separate', runtime: 'claude', model: {value: 'claude-opus-5-5', source: 'configured'}};
}

describe('directory listings', () => {
    test('directory pagination advances across hidden candidates and bounds an owner query', async () => {
        const relay = await fixture();
        const entries = [];
        for (let index = 0; index < 3; index++) {
            const joined = await room(relay);
            const result = await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: share(joined)});
            entries.push({joined, listingId: result.listing!.listingId});
        }
        // SQL uses byte order for identifiers, independent of the user's locale.
        entries.sort((a, b) => a.listingId < b.listingId ? -1 : 1);
        for (const entry of entries.slice(0, 2)) {
            await relay.service.setVisibility(entry.joined.roomId, entry.joined.controller, {handles: ['damien']});
        }
        const first = await relay.relay.handle(new Request('http://relay/v1/directory?limit=2', {headers: {'x-pairlobby-account-token': HUGO}}));
        const page = await first.json() as {listings: ListingView[]; next: string};
        expect(page.listings).toEqual([]);
        expect(page.next).toBe(entries[1]!.listingId);
        const next = await relay.relay.handle(new Request(`http://relay/v1/directory?limit=2&after=${page.next}`, {headers: {'x-pairlobby-account-token': HUGO}}));
        expect(await next.json()).toMatchObject({listings: [{listingId: entries[2]!.listingId}], next: null});
        const owner = await relay.relay.handle(new Request('http://relay/v1/directory?owner=damien&limit=1', {headers: {'x-pairlobby-account-token': DAMIEN}}));
        expect(await owner.json()).toMatchObject({listings: [{listingId: entries[0]!.listingId}], next: entries[0]!.listingId});
    });

    test('test_a_member_shares_an_agent_and_sharing_it_again_updates_the_same_listing', async () => {
        const relay = await fixture();
        const joined = await room(relay);
        const first = await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: share(joined)});
        expect(first.status).toBe(201);
        expect(first.listing).toEqual({listingId: expect.stringMatching(/^ls_/), owner: {handle: 'damien'}, agentName: 'backend-reviewer', roomName: 'payments', topic: 'Payment reconciliation', contact: 'questions', connection: 'separate', runtime: 'claude', model: {value: 'claude-opus-5-5', source: 'configured'}, availability: 'unknown', lastSeenAt: null, lastMessageAt: null, createdAt: 1_000_000, updatedAt: 1_000_000});

        relay.clock.now += 5_000;
        const again = await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: {...share(joined, 'Search indexing'), contact: 'tasks'}});
        expect(again.status).toBe(200);
        expect(again.listing).toMatchObject({listingId: first.listing!.listingId, topic: 'Search indexing', contact: 'tasks', createdAt: 1_000_000, updatedAt: 1_005_000});
    });

    test('test_a_heartbeat_reports_availability_and_the_agents_last_message', async () => {
        const relay = await fixture();
        const joined = await room(relay);
        const {listing} = await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: share(joined)});
        relay.clock.now += 10_000;
        await relay.service.send(joined.roomId, joined.agent, {type: 'message', recipientId: null, payload: {text: 'Done', priority: 'normal'}, idempotencyKey: newId('event')} as never);
        relay.clock.now += 10_000;
        const beat = await call(relay, `/${listing!.listingId}/presence`, 'PUT', {credential: joined.agent, token: DAMIEN, body: {availability: 'working', model: {value: 'claude-sonnet-5-5', source: 'reported'}}});
        expect(beat.status).toBe(200);
        expect(beat.listing).toMatchObject({availability: 'working', lastSeenAt: 1_020_000, lastMessageAt: 1_010_000, model: {value: 'claude-sonnet-5-5', source: 'reported'}});
    });

    test('test_the_relay_refuses_the_team_token_someone_elses_credential_or_listing_and_an_agent_that_left', async () => {
        const relay = await fixture();
        const joined = await room(relay);
        const other = await room(relay, 'hugo');
        const {listing} = await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: share(joined)});
        const presence = `/${listing!.listingId}/presence`;
        const beat = {availability: 'available'};

        const refusals: Array<[string, Promise<Call>, number]> = [
            ['the team token', call(relay, '', 'POST', {credential: joined.agent, token: TEAM, body: share(joined)}), 403],
            ['no token', call(relay, '', 'POST', {credential: joined.agent, body: share(joined)}), 403],
            ['the human in the room', call(relay, '', 'POST', {credential: joined.human, token: DAMIEN, body: share(joined)}), 401],
            ['the controller credential', call(relay, '', 'POST', {credential: joined.controller, token: DAMIEN, body: share(joined)}), 401],
            ['an agent from another room', call(relay, '', 'POST', {credential: other.agent, token: DAMIEN, body: share(joined)}), 401],
            ['an agent that joined as hugo', call(relay, '', 'POST', {credential: other.agent, token: DAMIEN, body: share(other)}), 401],
            ['hugo on damien\'s listing', call(relay, presence, 'PUT', {credential: joined.agent, token: HUGO, body: beat}), 404],
            ['hugo deleting damien\'s listing', call(relay, `/${listing!.listingId}`, 'DELETE', {token: HUGO}), 404],
            ['another agent\'s heartbeat', call(relay, presence, 'PUT', {credential: other.agent, token: DAMIEN, body: beat}), 401],
            ['a topic over two lines', call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: {...share(joined), topic: 'one\ntwo'}}), 400]
        ];
        for (const [what, response, status] of refusals) {
            expect((await response).status, what).toBe(status);
        }
        expect((await call(relay, '', 'POST', {token: TEAM, credential: joined.agent, body: share(joined)})).error?.message).toContain('personal login');

        await relay.service.leave(joined.roomId, joined.agent);
        expect((await call(relay, presence, 'PUT', {credential: joined.agent, token: DAMIEN, body: beat})).status).toBe(401);
        expect((await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: share(joined)})).status).toBe(401);
    });

    test('test_a_closed_room_refuses_sharing_and_the_owner_or_the_agent_can_take_a_listing_down', async () => {
        const relay = await fixture();
        const joined = await room(relay);
        const first = await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: share(joined)});
        expect((await call(relay, `/${first.listing!.listingId}`, 'DELETE', {credential: joined.agent})).status).toBe(204);
        expect(await relay.store.directory.listing(first.listing!.listingId)).toBeNull();

        const second = await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: share(joined)});
        expect(second.listing!.listingId).not.toBe(first.listing!.listingId);
        expect((await call(relay, `/${second.listing!.listingId}`, 'DELETE', {token: DAMIEN})).status).toBe(204);
        expect((await call(relay, `/${second.listing!.listingId}`, 'DELETE', {token: DAMIEN})).status).toBe(404);

        await relay.service.close(joined.roomId, joined.controller);
        expect((await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: share(joined)})).status).toBe(409);
    });

    test('test_the_sweep_deletes_listings_whose_room_closed_expired_or_was_deleted_or_whose_agent_left', async () => {
        const relay = await fixture();
        const rooms = await Promise.all(Array.from({length: 5}, () => room(relay)));
        const ids: string[] = [];
        for (const joined of rooms) {
            ids.push((await call(relay, '', 'POST', {credential: joined.agent, token: DAMIEN, body: share(joined)})).listing!.listingId);
        }
        const [kept, left, closed, expired, deleted] = rooms as [Joined, Joined, Joined, Joined, Joined];
        await relay.service.leave(left.roomId, left.agent);
        await relay.service.close(closed.roomId, closed.controller);
        await relay.service.setExpiry(expired.roomId, expired.controller, relay.clock.now + 60_000);
        await relay.service.delete(deleted.roomId, deleted.controller);
        relay.clock.now += 120_000;

        await relay.relay.tick('directory-sweep');
        const remaining: ListingRecord[] = await relay.store.directory.listings('', 100);
        expect(remaining.map((listing) => listing.roomId)).toEqual([kept.roomId]);
        expect(remaining[0]?.listingId).toBe(ids[0]);
    });

    test('test_a_listing_reads_offline_three_minutes_after_its_last_heartbeat_and_unknown_before_one', () => {
        const listing = {availability: 'paused', lastSeenAt: 1_000} as ListingRecord;
        expect(listingAvailability(listing, 1_000 + LISTING_OFFLINE_AFTER_MS - 1)).toBe('paused');
        expect(listingAvailability(listing, 1_000 + LISTING_OFFLINE_AFTER_MS)).toBe('offline');
        expect(listingAvailability({...listing, availability: null, lastSeenAt: null}, 1_000)).toBe('unknown');
    });

    test('test_a_participant_who_came_through_the_directory_carries_its_origin_into_the_room_and_onto_its_requests', async () => {
        const relay = await fixture();
        const joined = await room(relay);
        const code = newInviteCode();
        const origin: ParticipantOrigin = {directory: true, handle: 'hugo', listingId: newId('listing'), contact: 'questions'};
        await relay.store.putInvite({digest: await hashCredential(normalizeInviteCode(code)!), roomId: joined.roomId, role: 'member', createdAt: relay.clock.now, expiresAt: null, state: 'unused', reusable: false, boundAttemptId: null, boundCredentialHash: null, redeemedParticipantId: null, recoverableUntil: null, origin});
        const contact = newCredential('participant');
        const redeemed = await relay.service.redeemInvite({code, displayName: 'hugo', kind: 'human', participantCredential: contact, attemptId: newId('attempt'), member: 'hugo'});
        expect(redeemed.snapshot.participants.find((participant) => participant.participantId === redeemed.participantId)?.origin).toEqual(origin);

        const ask = (credential: string, text: string) => relay.service.send(joined.roomId, credential, {type: 'message', recipientId: joined.agentId, payload: {text, priority: 'normal'}, idempotencyKey: newId('event')} as never);
        await ask(contact, 'How does billing retry work?');
        await ask(joined.human, 'Please fix the retry.');
        const page = await relay.service.requests(joined.roomId, joined.agent, 0, 10, joined.agentId);
        expect(page.requests.map((request) => [request.text, request.origin])).toEqual([['How does billing retry work?', origin], ['Please fix the retry.', undefined]]);
    });

    test('test_the_last_message_lookup_uses_an_index_not_a_transcript_scan', async () => {
        const {store} = await fixture();
        const db = (store as unknown as {db: import('node:sqlite').DatabaseSync}).db;
        const plan = db.prepare("EXPLAIN QUERY PLAN SELECT json_extract(body, '$.at') AS at FROM events WHERE room_id = ? AND json_extract(body, '$.senderId') = ? AND json_extract(body, '$.type') = 'message' ORDER BY seq DESC LIMIT 1").all('rm_X', 'pt_X') as Array<{detail: string}>;
        expect(plan.map((row) => row.detail).join(' ')).toContain('events_by_sender');
    });
});

describe('the Node relay', () => {
    test('test_the_relay_offers_the_directory_only_with_personal_tokens', async () => {
        const path = join(directory, 'members.jsonl');
        writeFileSync(path, `${JSON.stringify((await issueMemberToken('damien')).line)}\n`);
        const withMembers = await startServer({port: 0, dataFile: join(directory, 'with.sqlite'), createToken: TEAM, members: {file: path}, discovery: {loginMode: 'token'}});
        const without = await startServer({port: 0, dataFile: join(directory, 'without.sqlite'), createToken: TEAM});
        try {
            const features = async (url: string) => ((await (await fetch(`${url}/v1/server`)).json()) as {features: string[]}).features;
            expect(await features(withMembers.url)).toContain('directory');
            expect(await features(without.url)).not.toContain('directory');
            expect((await fetch(`${without.url}/v1/directory/listings`, {method: 'POST', headers: {'x-pairlobby-account-token': TEAM}, body: '{}'})).status).toBe(404);
        } finally {
            await Promise.all([withMembers.close(), without.close()]);
        }
    });
});

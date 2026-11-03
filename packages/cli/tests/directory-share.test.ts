//! `pairlobby share` and `shared` against a relay with personal tokens, and the heartbeat a
//! listening receiver sends, on a schedule tested with an injected clock.

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {issueMemberToken, startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {ProtocolError} from '@pairlobby/protocol';
import type {ListingPresenceRequest} from '@pairlobby/protocol';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';

import {SHARE_AGENT_REFUSAL, heartbeatLine, listingStatus, shareCommand, sharedRows} from '../src/directory-share.js';
import type {ShareDeps, ShareOptions} from '../src/directory-share.js';
import {REFUSED} from '../src/endpoints.js';
import {loginOnline} from '../src/online.js';
import {receiverPresence} from '../src/receiver.js';
import {setupCommand} from '../src/setup.js';
import {HEARTBEAT_INTERVAL_MS, ListingHeartbeat, lastHeartbeat, saveListing, savedListing} from '../src/shared-listings.js';
import type {SavedListing} from '../src/shared-listings.js';

type Shared = {local: LocalStore; roomId: string; agentSession: string; humanSession: string; agentCredential: string};

type FakeClient = {calls: ListingPresenceRequest[]; fail: Error | null; client: PairLobbyClient};

let directory: string;
let relay: RunningServer;
let damienToken: string;
const stores: string[] = [];

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-directory-share-'));
    const damien = await issueMemberToken('damien');
    damienToken = damien.token;
    const members = join(directory, 'members.jsonl');
    writeFileSync(members, `${JSON.stringify(damien.line)}\n`);
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite'), createToken: 'team-token', members: {file: members}, discovery: {loginMode: 'token', name: 'Example Corp PairLobby'}});
});

afterAll(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

beforeEach(() => {
    for (const variable of ['PAIRLOBBY_ONLINE_ORIGIN', 'PAIRLOBBY_ACCOUNT_TOKEN', 'PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', 'PAIRLOBBY_CREATE_TOKEN', 'PAIRLOBBY_SERVER', 'PAIRLOBBY_ROOM', 'PAIRLOBBY_SESSION']) {
        vi.stubEnv(variable, '');
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const path of stores.splice(0)) {
        rmSync(path, {recursive: true, force: true});
    }
});

const person: ShareDeps = {interactive: true, agent: false, ask: async () => 'y'};

function options(update: Partial<ShareOptions> = {}): ShareOptions {
    return {topic: 'Payment reconciliation', off: false, yes: true, json: false, ...update};
}

function written(stream: NodeJS.WriteStream): string {
    return vi.mocked(stream.write).mock.calls.map(([chunk]) => String(chunk)).join('');
}

/** A device logged in as @damien, holding a room he created and an agent in it with a managed receiver configured. */
async function shared(login = true): Promise<Shared> {
    const path = mkdtempSync(join(tmpdir(), 'pairlobby-share-device-'));
    stores.push(path);
    const local = new LocalStore(path);
    await setupCommand(local, {url: relay.url, name: 'team', relays: [], yes: true, login: false, json: false, show: false, reset: false}, {interactive: true, agent: false, ask: async () => 'y', login: async () => null});
    if (login) {
        vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', damienToken);
        vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', relay.url);
        await loginOnline(local);
        vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', '');
        vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', '');
    }
    const client = new PairLobbyClient(relay.url, damienToken);
    const created = await client.createRoom('payments', {displayName: 'damien', kind: 'human'});
    const joined = await client.redeemInvite(created.invite.code, {displayName: 'backend-reviewer', kind: 'agent'});
    const base = {joinedAt: 0, lastReadSeq: 0, cwd: path};
    local.upsertRoom({roomId: created.roomId, name: 'payments', serverUrl: relay.url, createdAt: 0, expiresAt: null, controls: true, sessions: [
        {...base, participantId: created.participantId, sessionId: 'se_HUMAN', displayName: 'damien', kind: 'human', role: 'controller'},
        {...base, participantId: joined.participantId, sessionId: 'se_AGENT', displayName: 'backend-reviewer', kind: 'agent', role: 'member', runtime: 'claude', model: 'claude-opus-5-5'},
    ]});
    local.putCredential(created.roomId, 'se_HUMAN', created.participantCredential);
    local.putCredential(created.roomId, 'se_AGENT', joined.participantCredential);
    return {local, roomId: created.roomId, agentSession: 'se_AGENT', humanSession: 'se_HUMAN', agentCredential: joined.participantCredential};
}

function fakeClient(): FakeClient {
    const fake: FakeClient = {calls: [], fail: null, client: undefined as unknown as PairLobbyClient};
    fake.client = {listingPresence: async (_listingId: string, _credential: string, presence: ListingPresenceRequest) => {
        if (fake.fail) {
            throw fake.fail;
        }
        fake.calls.push(presence);
        return {};
    }} as unknown as PairLobbyClient;
    return fake;
}

function listing(local: LocalStore, listingId = 'ls_00000000000000000000000001'): SavedListing {
    const saved: SavedListing = {listingId, serverUrl: relay.url, roomId: 'rm_room', roomName: 'payments', sessionId: 'se_AGENT', agentName: 'backend-reviewer', topic: 'Payment reconciliation', contact: 'questions', connection: 'separate', sharedAt: 0};
    saveListing(local, saved);
    return saved;
}

describe('pairlobby share', () => {
    test('test_share_shows_what_colleagues_will_see_and_saves_nothing_when_the_person_declines', async () => {
        const {local, roomId, agentSession} = await shared();
        expect(await shareCommand(local, options({room: roomId, yes: false}), {...person, ask: async () => 'n'})).toBe(1);
        const preview = written(process.stderr);
        expect(preview).toContain(`Colleagues on ${new URL(relay.url).host} will see:`);
        expect(preview).toContain('  Agent       backend-reviewer');
        expect(preview).toContain('  Topic       Payment reconciliation');
        expect(preview).toContain('  Model       claude-opus-5-5 (configured)');
        expect(preview).toContain('  Contact     questions only; it answers read-only');
        expect(preview).toContain('Colleagues who contact this agent join payments and can read its history.');
        expect(savedListing(local, agentSession)).toBeNull();
    });

    test('test_share_lists_the_agent_sharing_again_updates_it_and_off_takes_it_down', async () => {
        const {local, roomId, agentSession, agentCredential} = await shared();
        expect(await shareCommand(local, options({room: roomId, yes: false}), person)).toBe(0);
        const first = savedListing(local, agentSession)!;
        expect(first).toMatchObject({listingId: expect.stringMatching(/^ls_/), roomId, agentName: 'backend-reviewer', topic: 'Payment reconciliation', contact: 'questions', connection: 'manual'});
        expect(sharedRows(local)).toEqual([{...first, heartbeat: null}]);

        expect(await shareCommand(local, options({room: roomId, topic: undefined, contact: 'tasks'}), person)).toBe(0);
        expect(savedListing(local, agentSession)).toEqual({...first, contact: 'tasks'});
        expect(written(process.stdout)).toContain('Updated backend-reviewer in the directory as "Payment reconciliation".');

        // The relay has the listing: a heartbeat from the agent is accepted.
        const client = new PairLobbyClient(relay.url, damienToken);
        expect(await client.listingPresence(first.listingId, agentCredential, {availability: 'available'})).toMatchObject({availability: 'available', contact: 'tasks'});

        expect(await shareCommand(local, options({room: roomId, off: true}), person)).toBe(0);
        expect(savedListing(local, agentSession)).toBeNull();
        await expect(client.listingPresence(first.listingId, agentCredential, {availability: 'available'})).rejects.toThrow('no such listing');
        await expect(shareCommand(local, options({room: roomId, off: true}), person)).rejects.toThrow('backend-reviewer is not shared from this device');
    });

    test('test_share_is_refused_to_agents_without_a_personal_login_without_confirmation_and_for_a_person', async () => {
        const {local, roomId, humanSession} = await shared();
        await expect(shareCommand(local, options({room: roomId}), {...person, agent: true})).rejects.toMatchObject({message: SHARE_AGENT_REFUSAL, exitCode: REFUSED});
        await expect(shareCommand(local, options({room: roomId, yes: false}), {...person, interactive: false})).rejects.toThrow('pairlobby share asks for confirmation');
        await expect(shareCommand(local, options({room: roomId, session: humanSession}), person)).rejects.toThrow('damien is not an agent member of payments');
        await expect(shareCommand(local, options({room: roomId, topic: 'two\nlines'}), person)).rejects.toThrow('one line of plain text');
        await expect(shareCommand(local, options({room: roomId, topic: undefined}), person)).rejects.toThrow('pairlobby share --topic');
        await expect(shareCommand(local, options({room: roomId, contact: 'everything'}), person)).rejects.toThrow('--contact is questions or tasks');

        const loggedOut = await shared(false);
        await expect(shareCommand(loggedOut.local, options({room: loggedOut.roomId}), person)).rejects.toThrow('Sharing needs your personal login');
    });
});

describe('heartbeats', () => {
    test('test_a_receiver_reports_its_state_and_its_configured_model_before_the_one_it_last_saw', () => {
        expect(receiverPresence({pid: 1, state: 'available', runtime: 'claude', model: 'reported-model'}, 'configured-model')).toEqual({availability: 'available', connection: 'separate', model: {value: 'configured-model', source: 'configured'}});
        expect(receiverPresence({pid: 1, state: 'working', runtime: 'claude', model: 'reported-model'})).toEqual({availability: 'working', connection: 'separate', model: {value: 'reported-model', source: 'reported'}});
        expect(receiverPresence({pid: 1, state: 'waiting', runtime: 'codex'})?.availability).toBe('working');
        expect(receiverPresence({pid: 1, state: 'provider_wait', runtime: 'codex'})?.availability).toBe('paused');
        expect(receiverPresence({pid: 1, state: 'paused', runtime: 'codex'})?.availability).toBe('paused');
        for (const state of ['starting', 'reconnecting', 'error', 'stopped']) {
            expect(receiverPresence({pid: 1, state, runtime: 'codex'})).toBeNull();
        }
    });

    test('test_a_heartbeat_goes_out_on_each_change_and_every_minute_and_offline_when_the_receiver_stops', async () => {
        const {local, agentSession} = await shared();
        const fake = fakeClient();
        const clock = {now: 1_000_000};
        let report: ListingPresenceRequest | null = {availability: 'available', connection: 'separate'};
        const heartbeat = new ListingHeartbeat({store: local, sessionId: agentSession, client: fake.client, credential: 'credential', report: () => report, now: () => clock.now});

        await heartbeat.tick();
        expect(fake.calls).toEqual([]);

        listing(local);
        await heartbeat.tick();
        clock.now += 30_000;
        await heartbeat.tick();
        expect(fake.calls).toEqual([{availability: 'available', connection: 'separate'}]);
        expect(lastHeartbeat(local, agentSession)).toEqual({listingId: 'ls_00000000000000000000000001', sentAt: 1_000_000, availability: 'available'});
        expect(listingStatus(local, agentSession)).toMatchObject({lastHeartbeatAt: 1_000_000, availability: 'available'});

        report = {availability: 'working', connection: 'separate'};
        await heartbeat.tick();
        clock.now += HEARTBEAT_INTERVAL_MS - 1;
        await heartbeat.tick();
        expect(fake.calls.map((call) => call.availability)).toEqual(['available', 'working']);
        clock.now += 1;
        await heartbeat.tick();
        expect(fake.calls.map((call) => call.availability)).toEqual(['available', 'working', 'working']);

        report = null;
        clock.now += HEARTBEAT_INTERVAL_MS;
        await heartbeat.tick();
        expect(fake.calls).toHaveLength(3);

        report = {availability: 'available', connection: 'separate'};
        await heartbeat.stop();
        expect(fake.calls.map((call) => call.availability)).toEqual(['available', 'working', 'working', 'offline']);
        expect(heartbeatLine(lastHeartbeat(local, agentSession), clock.now)).toBe('offline, heartbeat just now');
    });

    test('test_a_failed_heartbeat_is_recorded_and_retried_and_a_listing_the_relay_lost_is_left_alone', async () => {
        const {local, agentSession} = await shared();
        const fake = fakeClient();
        const clock = {now: 1_000_000};
        const heartbeat = new ListingHeartbeat({store: local, sessionId: agentSession, client: fake.client, credential: 'credential', report: () => ({availability: 'available', connection: 'separate'}), now: () => clock.now});
        listing(local);

        fake.fail = new ProtocolError('server_unavailable', 'could not reach the relay');
        await heartbeat.tick();
        expect(lastHeartbeat(local, agentSession)).toEqual({listingId: 'ls_00000000000000000000000001', sentAt: null, error: 'could not reach the relay'});
        fake.fail = null;
        clock.now += 10_000;
        await heartbeat.tick();
        expect(fake.calls).toHaveLength(0);
        clock.now += 5_000;
        await heartbeat.tick();
        expect(fake.calls).toHaveLength(1);
        expect(lastHeartbeat(local, agentSession)?.error).toBeUndefined();

        listing(local, 'ls_00000000000000000000000002');
        fake.fail = new ProtocolError('invalid_request', 'no such listing');
        await heartbeat.tick();
        expect(heartbeatLine(lastHeartbeat(local, agentSession))).toBe('heartbeat failing: the relay no longer lists this agent; run pairlobby share again');
        fake.fail = null;
        clock.now += HEARTBEAT_INTERVAL_MS;
        await heartbeat.tick();
        await heartbeat.stop();
        expect(fake.calls).toHaveLength(1);
    });

    test('test_heartbeats_reach_the_relay_and_offline_shows_at_once', async () => {
        const {local, roomId, agentSession, agentCredential} = await shared();
        await shareCommand(local, options({room: roomId}), person);
        const heartbeat = new ListingHeartbeat({store: local, sessionId: agentSession, client: new PairLobbyClient(relay.url, damienToken), credential: agentCredential, report: () => ({availability: 'working', connection: 'separate'})});
        await heartbeat.tick();
        await heartbeat.stop();
        const view = await new PairLobbyClient(relay.url, damienToken).shareListing(agentCredential, {roomId, topic: 'Payment reconciliation', contact: 'questions', connection: 'separate'});
        expect(view).toMatchObject({availability: 'offline', connection: 'separate'});
        expect(lastHeartbeat(local, agentSession)).toMatchObject({availability: 'offline'});
    });
});

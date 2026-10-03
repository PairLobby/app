import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import type {InviteProbeResult} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

import {findLocalRoom, findRelayForInvite} from './relay-discovery.js';
import type {DiscoveryDeps, LocalRoomDeps, RelayCandidate} from './relay-discovery.js';

type FakeRelays = Record<string, InviteProbeResult>;

const CODE = 'K7MP-4QWX';
let directory: string;
let servers: RunningServer[];

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-discovery-'));
    servers = [];
});

afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    rmSync(directory, {recursive: true, force: true});
});

function fake(local: InviteProbeResult, lan: FakeRelays, tailnet: FakeRelays = {}): DiscoveryDeps & {asked: string[]} {
    const asked: string[] = [];
    const answers: FakeRelays = {'http://127.0.0.1:8790': local, ...lan, ...tailnet};
    const candidates = (relays: FakeRelays, label: string): RelayCandidate[] => Object.keys(relays).map((url) => ({url, label}));
    return {
        asked,
        local: 'http://127.0.0.1:8790',
        lan: async () => candidates(lan, 'local network'),
        tailnet: async () => candidates(tailnet, 'desktop'),
        probe: async (url, probe) => {
            expect(probe).toMatch(/^[0-9a-f]{4}$/);
            asked.push(url);
            return answers[url] ?? 'unreachable';
        },
    };
}

test('test_this_devices_relay_wins_when_it_issued_the_code', async () => {
    expect(await findRelayForInvite(CODE, fake('known', {'http://10.0.0.5:8790': 'known'}))).toBe('http://127.0.0.1:8790');
});

test('test_the_one_relay_that_knows_the_code_is_chosen', async () => {
    const deps = fake('unknown', {'http://10.0.0.5:8790': 'unknown'}, {'http://100.125.214.0:8790': 'known', 'http://100.119.62.36:8790': 'unreachable'});
    expect(await findRelayForInvite(CODE, deps)).toBe('http://100.125.214.0:8790');
    expect(deps.asked).toHaveLength(4);
});

test('test_two_relays_claiming_a_code_get_neither_and_list_both', async () => {
    const deps = fake('unknown', {'http://10.0.0.5:8790': 'known'}, {'http://100.125.214.0:8790': 'known'});
    await expect(findRelayForInvite(CODE, deps)).rejects.toThrow(/more than one relay[\s\S]*--server http:\/\/10\.0\.0\.5:8790[\s\S]*--server http:\/\/100\.125\.214\.0:8790/);
});

test('test_an_older_local_relay_stays_the_default_when_nobody_claims_the_code', async () => {
    expect(await findRelayForInvite(CODE, fake('unsupported', {'http://10.0.0.5:8790': 'unknown'}))).toBe('http://127.0.0.1:8790');
});

test('test_no_relay_claiming_the_code_explains_what_was_searched', async () => {
    await expect(findRelayForInvite(CODE, fake('unreachable', {}, {'http://100.125.214.0:8790': 'unreachable'}))).rejects.toThrow(/no relay this device can see issued K7MP-4QWX \(searched this device \(no relay running\), 0 on the local network, 1 Tailscale device\(s\), 0 with a relay\)/);
});

test('test_a_malformed_code_goes_to_this_device_unprobed', async () => {
    const deps = fake('unknown', {'http://10.0.0.5:8790': 'known'});
    expect(await findRelayForInvite('abc', deps)).toBe('http://127.0.0.1:8790');
    expect(deps.asked).toEqual([]);
});

test('test_real_relays_are_told_only_the_probe_and_the_issuer_is_found', async () => {
    const mine = await startServer({port: 0, dataFile: join(directory, 'mine.sqlite')});
    const theirs = await startServer({port: 0, dataFile: join(directory, 'theirs.sqlite')});
    servers.push(mine, theirs);
    const created = await new PairLobbyClient(theirs.url).createRoom('elsewhere', {displayName: 'hugo', kind: 'human'});
    const deps: DiscoveryDeps = {local: mine.url, lan: async () => [], tailnet: async () => [{url: theirs.url, label: 'desktop'}], probe: (url, probe) => new PairLobbyClient(url).probeInvite(probe)};
    expect(await findRelayForInvite(created.invite.code, deps)).toBe(theirs.url);
    const joined = await new PairLobbyClient(await findRelayForInvite(created.invite.code, deps)).redeemInvite(created.invite.code, {displayName: 'claude', kind: 'agent'});
    expect(joined.roomId).toBe(created.roomId);
});

function rooms(entries: Record<string, string[]>): LocalRoomDeps {
    const list = (urls: string[], label: string): RelayCandidate[] => urls.map((url) => ({url, label}));
    return {
        local: 'http://127.0.0.1:8790',
        lan: async () => list(Object.keys(entries).filter((url) => url.startsWith('http://10.')), 'local network'),
        tailnet: async () => list(Object.keys(entries).filter((url) => url.startsWith('http://100.')), 'desktop'),
        lookup: async (url) => url in entries ? entries[url]!.map((roomId) => ({roomId, name: 'tower-test', createdAt: 0, participantCount: 1})) : null,
    };
}

test('test_a_room_name_resolves_to_the_one_relay_holding_it', async () => {
    const found = await findLocalRoom('tower-test', rooms({'http://127.0.0.1:8790': [], 'http://100.111.208.123:8790': ['rm_A']}));
    expect([found.url, found.room.roomId]).toEqual(['http://100.111.208.123:8790', 'rm_A']);
});

test('test_two_rooms_with_one_name_are_listed_for_the_person_to_pick', async () => {
    await expect(findLocalRoom('tower-test', rooms({'http://127.0.0.1:8790': ['rm_A'], 'http://10.0.0.5:8790': ['rm_B']}))).rejects.toThrow(/more than one room named "tower-test"[\s\S]*join local rm_A --server http:\/\/127\.0\.0\.1:8790[\s\S]*join local rm_B --server http:\/\/10\.0\.0\.5:8790/);
});

test('test_no_room_by_that_name_says_how_many_relays_answered', async () => {
    await expect(findLocalRoom('tower-test', rooms({'http://127.0.0.1:8790': []}))).rejects.toThrow(/no room named "tower-test" is open to the local network on the 1 relay\(s\) that answered \(of 1 this device can see\)/);
});

test('test_a_named_relay_is_the_only_one_asked', async () => {
    const asked: string[] = [];
    const deps = {...rooms({'http://10.0.0.5:8790': ['rm_B']}), lookup: async (url: string) => {
        asked.push(url);
        return [{roomId: 'rm_C', name: 'tower-test', createdAt: 0, participantCount: 1}];
    }};
    expect((await findLocalRoom('tower-test', deps, 'http://laptop:8790')).room.roomId).toBe('rm_C');
    expect(asked).toEqual(['http://laptop:8790']);
});

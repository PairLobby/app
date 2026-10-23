import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {LocalStore} from '@pairlobby/client';

import {DEFAULT_LOCAL_SERVER, UsageError, hostedAccountToken, resolveServer} from '../src/context.js';
import {activeEndpoint, endpointRelay, normalizeOrigin, saveEndpoint, useEndpointOverride} from '../src/endpoints.js';
import {invitationNotice, readInvitationNotice, rememberInvitations} from '../src/invitation-notice.js';
import {accountToken, accountTokenFor, loginOnline, logoutOnline, resolveOnlineKey} from '../src/online.js';
import {AGENT_REFUSAL, probeEndpoint, setupCommand} from '../src/setup.js';
import type {SetupDeps, SetupOptions} from '../src/setup.js';

const directories: string[] = [];

beforeEach(() => {
    for (const variable of ['PAIRLOBBY_ONLINE_ORIGIN', 'PAIRLOBBY_ACCOUNT_TOKEN', 'PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', 'PAIRLOBBY_SERVER']) {
        vi.stubEnv(variable, '');
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    useEndpointOverride(undefined);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) {
        rmSync(directory, {recursive: true, force: true});
    }
});

function store(): LocalStore {
    const path = mkdtempSync(join(tmpdir(), 'pairlobby-setup-test-'));
    directories.push(path);
    return new LocalStore(path);
}

function options(overrides: Partial<SetupOptions> = {}): SetupOptions {
    return {relays: [], yes: false, login: false, json: false, show: false, reset: false, ...overrides};
}

function deps(overrides: Partial<SetupDeps> = {}): SetupDeps {
    return {interactive: true, agent: false, ask: async () => 'y', login: async () => 'person@example.com', ...overrides};
}

type Route = {status: number; body?: unknown};

/** A fake host answering GETs by path, recording every request so a write can be caught. */
function host(routes: Record<string, Route | 'redirect' | 'timeout'>) {
    const calls: {url: string; method: string}[] = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({url: String(input), method: init?.method ?? 'GET'});
        const route = routes[new URL(String(input)).pathname];
        if (route === 'redirect') {
            throw new TypeError('fetch failed: unexpected redirect');
        }
        if (route === 'timeout') {
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }
        if (!route) {
            return new Response('not found', {status: 404});
        }
        return Response.json(route.body ?? {}, {status: route.status});
    });
    vi.stubGlobal('fetch', fetcher);
    return calls;
}

const RELAY = {'/v1/server': {status: 200, body: {shareUrls: [], discoverable: false, version: '0.21.0'}}};
const ACCOUNT = {'/api/online/account': {status: 401, body: {error: {code: 'unauthorized', message: 'Account token required'}}}};

test('test_addresses_are_normalized_to_an_origin_and_unsafe_ones_refused', () => {
    expect(normalizeOrigin('pairlobby.example.com')).toBe('https://pairlobby.example.com');
    expect(normalizeOrigin('https://pairlobby.example.com')).toBe('https://pairlobby.example.com');
    expect(normalizeOrigin('https://PairLobby.Example.com/')).toBe('https://pairlobby.example.com');
    expect(normalizeOrigin('https://pairlobby.example.com:443')).toBe('https://pairlobby.example.com');
    expect(normalizeOrigin('https://pairlobby.example.com:8443')).toBe('https://pairlobby.example.com:8443');
    expect(normalizeOrigin('http://127.0.0.1:8792')).toBe('http://127.0.0.1:8792');
    expect(normalizeOrigin('http://localhost:8792')).toBe('http://localhost:8792');
    for (const refused of ['http://pairlobby.example.com', 'https://user:secret@pairlobby.example.com', 'https://pairlobby.example.com/relay', 'https://pairlobby.example.com/?a=1', 'https://pairlobby.example.com/#x', '', '   ', 'https://']) {
        expect(() => normalizeOrigin(refused), refused).toThrow(UsageError);
    }
});

test('test_the_probe_finds_a_relay_or_an_account_service_with_get_requests_only', async () => {
    const relayCalls = host(RELAY);
    expect(await probeEndpoint('https://relay.example.com')).toEqual({kind: 'relay', name: 'relay.example.com', loginMode: 'none', relayOrigins: ['https://relay.example.com']});
    expect(relayCalls.every((call) => call.method === 'GET')).toBe(true);

    const accountCalls = host(ACCOUNT);
    expect(await probeEndpoint('https://accounts.example.com')).toMatchObject({kind: 'account', loginMode: 'browser'});
    expect(accountCalls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
    expect(accountCalls.map((call) => new URL(call.url).pathname)).toEqual(['/.well-known/pairlobby.json', '/v1/server', '/api/online/account']);
});

test('test_the_probe_reads_a_discovery_document_first', async () => {
    host({'/.well-known/pairlobby.json': {status: 200, body: {version: 1, name: 'Example \u001b[31mCorp\u001b[0m PairLobby', login: {mode: 'token'}, relays: ['https://relay.example.com'], future: true}}, ...RELAY});
    expect(await probeEndpoint('https://pairlobby.example.com')).toEqual({kind: 'discovery', name: 'Example Corp PairLobby', loginMode: 'token', relayOrigins: ['https://relay.example.com'], verify: '/api/online/account'});

    host({'/.well-known/pairlobby.json': {status: 200, body: {version: 2, login: {mode: 'token'}}}});
    await expect(probeEndpoint('https://pairlobby.example.com')).rejects.toMatchObject({exitCode: 3});
});

test('test_a_host_that_is_not_pairlobby_redirects_or_times_out_exits_3', async () => {
    host({});
    await expect(probeEndpoint('https://example.com')).rejects.toMatchObject({exitCode: 3, message: 'https://example.com does not look like a PairLobby deployment'});
    host({'/.well-known/pairlobby.json': 'redirect', '/v1/server': 'redirect', '/api/online/account': 'redirect'});
    await expect(probeEndpoint('https://example.com')).rejects.toMatchObject({exitCode: 3});
    host({'/.well-known/pairlobby.json': 'timeout', '/v1/server': 'timeout', '/api/online/account': 'timeout'});
    await expect(probeEndpoint('https://example.com')).rejects.toMatchObject({exitCode: 3});
});

test('test_setup_confirms_saves_and_makes_the_endpoint_active', async () => {
    const calls = host(RELAY);
    const local = store();
    const asked: string[] = [];
    expect(await setupCommand(local, options({url: 'relay.example.com', name: 'team'}), deps({ask: async (question) => { asked.push(question); return 'y'; }}))).toBe(0);
    expect(asked).toEqual(['Use this endpoint for login, online rooms and invitations on this device? [y/N] ']);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(activeEndpoint(new LocalStore(local.directory))).toMatchObject({label: 'team', origin: 'https://relay.example.com', loginMode: 'none', hosted: false});

    const declined = store();
    expect(await setupCommand(declined, options({url: 'relay.example.com'}), deps({ask: async () => ''}))).toBe(1);
    expect(declined.settings().endpoints).toBeUndefined();
});

test('test_setup_needs_a_terminal_or_yes_and_refuses_agents', async () => {
    host(RELAY);
    const local = store();
    await expect(setupCommand(local, options({url: 'relay.example.com'}), deps({interactive: false}))).rejects.toMatchObject({exitCode: 2});
    expect(await setupCommand(local, options({url: 'relay.example.com', yes: true}), deps({interactive: false}))).toBe(0);

    const agent = store();
    await expect(setupCommand(agent, options({url: 'relay.example.com', yes: true}), deps({agent: true}))).rejects.toMatchObject({exitCode: 4, message: AGENT_REFUSAL});
    for (const refused of [{use: 'pairlobby'}, {remove: 'team'}, {reset: true}, {}]) {
        await expect(setupCommand(agent, options(refused), deps({agent: true}))).rejects.toMatchObject({exitCode: 4});
    }
    expect(agent.settings().endpoints).toBeUndefined();
    expect(await setupCommand(agent, options({show: true}), deps({agent: true}))).toBe(0);
    expect(await setupCommand(agent, options(), deps({agent: true, interactive: false}))).toBe(0);
});

test('test_labels_follow_the_rules_and_pairlobby_is_reserved', async () => {
    host(RELAY);
    const local = store();
    await expect(setupCommand(local, options({url: 'relay.example.com', name: 'pairlobby', yes: true}), deps())).rejects.toThrow('reserved');
    await expect(setupCommand(local, options({url: 'relay.example.com', name: 'A', yes: true}), deps())).rejects.toThrow('2 to 32');
    await setupCommand(local, options({url: 'pairlobby.example.com', yes: true}), deps());
    expect(local.settings().activeEndpoint).toBe('example');
    await setupCommand(local, options({url: 'team.example.com', yes: true}), deps());
    expect(local.settings().activeEndpoint).toBe('team');
    await expect(setupCommand(local, options({url: 'other.example.com', name: 'team', yes: true}), deps())).rejects.toThrow('already names https://team.example.com');
});

test('test_use_remove_and_reset_switch_without_moving_tokens', async () => {
    host(RELAY);
    const local = store();
    await setupCommand(local, options({url: 'a.example.com', name: 'alpha', yes: true}), deps());
    await setupCommand(local, options({url: 'b.example.com', name: 'beta', yes: true}), deps());
    local.putCredential('online-account', 'https://a.example.com', 'token-a');
    local.putCredential('online-account', 'https://b.example.com', 'token-b');
    local.putCredential('online-account', 'https://pairlobby.com', 'token-hosted');

    await setupCommand(local, options({use: 'alpha'}), deps());
    expect(accountToken(local)).toBe('token-a');
    await setupCommand(local, options({use: 'pairlobby'}), deps());
    expect(activeEndpoint(local).origin).toBe('https://pairlobby.com');
    expect(accountToken(local)).toBe('token-hosted');
    await setupCommand(local, options({use: 'beta'}), deps());
    await setupCommand(local, options({reset: true}), deps());
    expect(activeEndpoint(local).origin).toBe('https://pairlobby.com');
    expect(Object.keys(local.settings().endpoints!)).toEqual(['alpha', 'beta']);

    await setupCommand(local, options({remove: 'alpha'}), deps());
    expect(local.credential('online-account', 'https://a.example.com')).toBeUndefined();
    expect(local.credential('online-account', 'https://b.example.com')).toBe('token-b');
    expect(local.credential('online-account', 'https://pairlobby.com')).toBe('token-hosted');
    await expect(setupCommand(local, options({remove: 'pairlobby'}), deps())).rejects.toThrow('built in');
    await expect(setupCommand(local, options({use: 'missing'}), deps())).rejects.toThrow('No endpoint called "missing"');

    local.resetSettings();
    expect(Object.keys(local.settings().endpoints!)).toEqual(['beta']);
});

test('test_precedence_is_environment_then_flag_then_saved_then_pairlobby_com', () => {
    const local = store();
    expect(activeEndpoint(local).origin).toBe('https://pairlobby.com');
    saveEndpoint(local, {label: 'team', origin: 'https://team.example.com', name: 'Team', relayOrigins: ['https://team.example.com'], loginMode: 'token'});
    saveEndpoint(local, {label: 'other', origin: 'https://other.example.com', name: 'Other', relayOrigins: ['https://other.example.com'], loginMode: 'browser'});
    expect(activeEndpoint(local).label).toBe('other');
    useEndpointOverride('team');
    expect(activeEndpoint(local).label).toBe('team');
    useEndpointOverride('https://adhoc.example.com');
    expect(activeEndpoint(local)).toMatchObject({origin: 'https://adhoc.example.com', hosted: true});
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', 'https://team.example.com');
    expect(activeEndpoint(local).label).toBe('team');
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', 'https://env.example.com');
    expect(activeEndpoint(local)).toMatchObject({origin: 'https://env.example.com', hosted: true});
});

test('test_the_token_variable_is_ignored_for_an_endpoint_it_is_not_scoped_to', async () => {
    const local = store();
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', 'from-environment');
    expect(accountToken(local)).toBe('from-environment');

    saveEndpoint(local, {label: 'team', origin: 'https://team.example.com', name: 'Team', relayOrigins: ['https://team.example.com'], loginMode: 'browser'});
    local.putCredential('online-account', 'https://team.example.com', 'saved-team');
    expect(accountToken(local)).toBe('saved-team');
    expect(vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0])).join('')).toMatch(/PAIRLOBBY_ACCOUNT_TOKEN ignored: it is not scoped to https:\/\/team\.example\.com/);

    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', 'https://team.example.com');
    expect(accountToken(local)).toBe('from-environment');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', '');
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', 'https://team.example.com');
    expect(accountToken(local)).toBe('from-environment');

    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', '');
    local.forgetCredential('online-account', 'https://team.example.com');
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response('not found', {status: 404}));
    vi.stubGlobal('fetch', fetcher);
    await expect(loginOnline(local, {paste: true})).rejects.toThrow();
    // Only the discovery document was read; the unscoped token went nowhere.
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual(['https://team.example.com/.well-known/pairlobby.json']);
    expect(fetcher.mock.calls.every((call) => !JSON.stringify(call[1]?.headers ?? {}).includes('from-environment'))).toBe(true);
    expect(local.credential('online-account', 'https://team.example.com')).toBeUndefined();
});

test('test_tokens_go_only_to_the_endpoint_origin_or_its_declared_relays', async () => {
    const local = store();
    saveEndpoint(local, {label: 'team', origin: 'https://team.example.com', name: 'Team', relayOrigins: ['https://team.example.com', 'https://relay.example.com'], loginMode: 'token'});
    local.putCredential('online-account', 'https://team.example.com', 'team-token');
    expect(accountTokenFor(local, 'https://team.example.com')).toBe('team-token');
    expect(accountTokenFor(local, 'https://relay.example.com/')).toBe('team-token');
    expect(hostedAccountToken(local, 'https://relay.example.com')).toBe('team-token');
    expect(accountTokenFor(local, 'https://elsewhere.example.com')).toBeUndefined();
    expect(accountTokenFor(local, 'http://127.0.0.1:8790')).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({server: 'https://relay.example.com'})).mockResolvedValueOnce(Response.json({server: 'https://elsewhere.example.com'})));
    expect(await resolveOnlineKey(local, 'ABCD-EFGH-JKMN')).toBe('https://relay.example.com/');
    await expect(resolveOnlineKey(local, 'ABCD-EFGH-JKMN')).rejects.toThrow('invalid room address');

    await setupCommand(local, options({use: 'pairlobby'}), deps());
    local.putCredential('online-account', 'https://pairlobby.com', 'hosted-token');
    expect(accountTokenFor(local, 'https://pairlobby.com/relay/workspace/team')).toBe('hosted-token');
    expect(accountTokenFor(local, 'https://pairlobby.com/account')).toBeUndefined();
    expect(accountTokenFor(local, 'https://team.example.com')).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({server: 'https://pairlobby.com/not-a-relay'})));
    await expect(resolveOnlineKey(local, 'ABCD-EFGH-JKMN')).rejects.toThrow('invalid room address');
});

test('test_logout_of_one_endpoint_keeps_the_other_logged_in', async () => {
    const local = store();
    saveEndpoint(local, {label: 'alpha', origin: 'https://a.example.com', name: 'Alpha', relayOrigins: ['https://a.example.com'], loginMode: 'browser'});
    saveEndpoint(local, {label: 'beta', origin: 'https://b.example.com', name: 'Beta', relayOrigins: ['https://b.example.com'], loginMode: 'browser'});
    local.putCredential('online-account', 'https://a.example.com', 'token-a');
    local.putCredential('online-account', 'https://b.example.com', 'token-b');
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => Response.json({}));
    vi.stubGlobal('fetch', fetcher);

    expect(await logoutOnline(local)).toEqual({removed: true, revoked: true});
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://b.example.com/api/device/revoke');
    expect(local.credential('online-account', 'https://b.example.com')).toBeUndefined();
    expect(local.credential('online-account', 'https://a.example.com')).toBe('token-a');
});

test('test_the_invitation_reminder_belongs_to_the_active_endpoint', () => {
    const local = store();
    local.putCredential('online-account', 'https://pairlobby.com', 'hosted-token');
    rememberInvitations(local, [{id: 'i1', roomId: 'rm_A', roomName: 'Hosted room', invitedBy: '@maria', role: 'member', agents: 0, createdAt: 1, expiresAt: 2}]);
    expect(invitationNotice(local)).toMatch(/Hosted room/);

    saveEndpoint(local, {label: 'team', origin: 'https://team.example.com', name: 'Team', relayOrigins: ['https://team.example.com'], loginMode: 'browser'});
    local.putCredential('online-account', 'https://team.example.com', 'team-token');
    expect(readInvitationNotice(local).waiting).toEqual([]);
    expect(invitationNotice(local)).toBeNull();
    rememberInvitations(local, [{id: 'i2', roomId: 'rm_B', roomName: 'Team room', invitedBy: '@sam', role: 'member', agents: 0, createdAt: 1, expiresAt: 2}]);
    expect(invitationNotice(local)).toMatch(/Team room/);
    expect(readInvitationNotice(local, 'https://pairlobby.com').waiting.map((entry) => entry.roomName)).toEqual(['Hosted room']);

    saveEndpoint(local, {label: 'tokens', origin: 'https://tokens.example.com', name: 'Tokens', relayOrigins: ['https://tokens.example.com'], loginMode: 'token'});
    local.putCredential('online-account', 'https://tokens.example.com', 'shared-token');
    expect(invitationNotice(local)).toBeNull();
});

test('test_a_saved_endpoint_with_one_relay_is_the_default_relay', () => {
    const local = store();
    expect(endpointRelay(local)).toBeUndefined();
    saveEndpoint(local, {label: 'team', origin: 'https://team.example.com', name: 'Team', relayOrigins: ['https://team.example.com'], loginMode: 'token'});
    expect(endpointRelay(local)).toBe('https://team.example.com');
    expect(resolveServer({fallback: endpointRelay(local)})).toBe('https://team.example.com');
    expect(resolveServer({server: 'https://chosen.example.com', fallback: endpointRelay(local)})).toBe('https://chosen.example.com');
    vi.stubEnv('PAIRLOBBY_SERVER', 'http://10.0.0.5:8790');
    expect(resolveServer({fallback: endpointRelay(local)})).toBe('http://10.0.0.5:8790');
    vi.stubEnv('PAIRLOBBY_SERVER', '');

    saveEndpoint(local, {label: 'declared', origin: 'https://login.example.com', name: 'Declared', relayOrigins: ['https://relay.example.com'], loginMode: 'token'});
    expect(endpointRelay(local)).toBe('https://relay.example.com');
    saveEndpoint(local, {label: 'several', origin: 'https://many.example.com', name: 'Several', relayOrigins: ['https://many.example.com', 'https://second.example.com'], loginMode: 'token'});
    expect(endpointRelay(local)).toBeUndefined();
    expect(resolveServer({fallback: endpointRelay(local)})).toBe(DEFAULT_LOCAL_SERVER);
});

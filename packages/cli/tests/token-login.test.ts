import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, afterEach, beforeAll, beforeEach, expect, test, vi} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

import {activeEndpoint, saveEndpoint} from '../src/endpoints.js';
import {accountToken, createTokenFor, loginOnline, logoutOnline, onlineAccount, onlineRooms, requireAccountApi} from '../src/online.js';
import {setupCommand} from '../src/setup.js';

const TEAM_TOKEN = 'team-secret-token';
let directory: string;
let team: RunningServer;
let plain: RunningServer;
const stores: string[] = [];

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-token-login-'));
    team = await startServer({port: 0, dataFile: join(directory, 'team.sqlite'), createToken: TEAM_TOKEN, discovery: {loginMode: 'token', name: 'Example Corp PairLobby', loginHelp: 'Ask your team lead for the PairLobby team token.'}});
    plain = await startServer({port: 0, dataFile: join(directory, 'plain.sqlite'), discovery: {loginMode: 'none', name: 'Plain relay'}});
});

afterAll(async () => {
    await Promise.all([team.close(), plain.close()]);
    rmSync(directory, {recursive: true, force: true});
});

beforeEach(() => {
    for (const variable of ['PAIRLOBBY_ONLINE_ORIGIN', 'PAIRLOBBY_ACCOUNT_TOKEN', 'PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', 'PAIRLOBBY_CREATE_TOKEN', 'PAIRLOBBY_SERVER']) {
        vi.stubEnv(variable, '');
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const path of stores.splice(0)) {
        rmSync(path, {recursive: true, force: true});
    }
});

function store(): LocalStore {
    const path = mkdtempSync(join(tmpdir(), 'pairlobby-token-device-'));
    stores.push(path);
    return new LocalStore(path);
}

const human = {interactive: true, agent: false, ask: async () => 'y', login: async () => null};

/** The team token, offered the way a script would: scoped to the team relay's origin. */
function offerToken(token: string): void {
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', token);
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', team.url);
}

async function setUpTeam(local: LocalStore): Promise<void> {
    await setupCommand(local, {url: team.url, name: 'team', relays: [], yes: true, login: false, json: false, show: false, reset: false}, human);
}

test('test_setup_reads_the_relays_discovery_document', async () => {
    const local = store();
    await setUpTeam(local);
    expect(activeEndpoint(local)).toMatchObject({label: 'team', origin: team.url, name: 'Example Corp PairLobby', loginMode: 'token', relayOrigins: [team.url], hosted: false});
});

test('test_token_login_saves_the_team_token_only_when_the_relay_accepts_it', async () => {
    const local = store();
    await setUpTeam(local);
    offerToken('wrong-token');
    await expect(loginOnline(local)).rejects.toThrow('this is not the team token for this relay');
    expect(local.credential('online-account', team.url)).toBeUndefined();

    offerToken(TEAM_TOKEN);
    expect(await loginOnline(local)).toBeNull();
    expect(local.credential('online-account', team.url)).toBe(TEAM_TOKEN);
});

test('test_create_online_puts_the_room_on_the_team_relay_with_the_saved_token', async () => {
    const local = store();
    await setUpTeam(local);
    local.putCredential('online-account', team.url, TEAM_TOKEN);
    requireAccountApi(local, 'create online');
    const account = await onlineAccount(local);
    expect(account).toEqual({email: null, userId: 'team', name: 'Example Corp PairLobby', server: team.url, handle: null});
    const created = await new PairLobbyClient(account.server, accountToken(local)).createRoom('demo', {displayName: 'alice', kind: 'human'});
    expect(created.room.name).toBe('demo');
    await expect(new PairLobbyClient(account.server).createRoom('no token', {displayName: 'eve', kind: 'human'})).rejects.toThrow('create token');
});

test('test_logout_in_token_mode_forgets_without_asking_anyone_to_revoke', async () => {
    const local = store();
    await setUpTeam(local);
    local.putCredential('online-account', team.url, TEAM_TOKEN);
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect(await logoutOnline(local)).toEqual({removed: true, revoked: null});
    expect(fetcher).not.toHaveBeenCalled();
    expect(local.credential('online-account', team.url)).toBeUndefined();
});

test('test_commands_a_token_or_plain_relay_does_not_offer_say_so', async () => {
    const local = store();
    await setUpTeam(local);
    for (const command of ['find online', 'join online', 'invitations', 'profile --username']) {
        expect(() => requireAccountApi(local, command)).toThrow(`This deployment (Example Corp PairLobby) does not offer ${command}. Use an invite code or pairlobby create online.`);
    }

    await setupCommand(local, {url: plain.url, name: 'plain', relays: [], yes: true, login: false, json: false, show: false, reset: false}, human);
    expect(() => requireAccountApi(local, 'create online')).toThrow('This deployment (Plain relay) does not offer create online. Use an invite code, or pairlobby create.');
    await expect(loginOnline(local)).rejects.toThrow('This deployment (Plain relay) has no login. Use an invite code, or pairlobby create --server <relay>.');
});

test('test_a_404_from_a_saved_endpoint_refreshes_what_it_says_about_itself', async () => {
    const local = store();
    // Saved before the relay offered token login, as if it had changed since.
    saveEndpoint(local, {label: 'team', origin: team.url, name: 'Old name', relayOrigins: [team.url], loginMode: 'browser'});
    local.putCredential('online-account', team.url, TEAM_TOKEN);
    await expect(onlineRooms(local)).rejects.toThrow();
    expect(activeEndpoint(local)).toMatchObject({name: 'Example Corp PairLobby', loginMode: 'token'});
});

test('test_plain_create_never_sends_an_unscoped_account_token_to_a_relay', async () => {
    const local = store();
    // On pairlobby.com, a token in PAIRLOBBY_ACCOUNT_TOKEN belongs to pairlobby.com, not to the team relay.
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', TEAM_TOKEN);
    expect(createTokenFor(local, team.url)).toBeUndefined();
    await expect(new PairLobbyClient(team.url, createTokenFor(local, team.url)).createRoom('leaked', {displayName: 'alice', kind: 'human'})).rejects.toThrow('create token');

    vi.stubEnv('PAIRLOBBY_CREATE_TOKEN', TEAM_TOKEN);
    expect(createTokenFor(local, team.url)).toBe(TEAM_TOKEN);
    vi.stubEnv('PAIRLOBBY_CREATE_TOKEN', '');

    await setUpTeam(local);
    offerToken(TEAM_TOKEN);
    expect(createTokenFor(local, team.url)).toBe(TEAM_TOKEN);
    expect(createTokenFor(local, plain.url)).toBeUndefined();
});

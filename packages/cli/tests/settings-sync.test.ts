import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {afterEach, beforeEach, expect, test, vi} from 'vitest';

import {LocalStore} from '@pairlobby/client';
import {AccountSettingsError, parseAccountSettingChanges} from '@pairlobby/protocol';
import type {AccountSettingsMap} from '@pairlobby/protocol';

import {SETTINGS_PATH, disableSync, enableSync, offerSettingsSync, pendingSettings, pushSettings, settingDifferences, syncSettings, syncStatus} from '../src/settings-sync.js';

const TOKEN = 'settings-sync-token';

type FakeSettingsService = {origin: string; settings: AccountSettingsMap; clock: () => number; available: boolean; calls: string[]; close: () => Promise<void>};

/** Newest wins, a tie to the later write, and times from the future pulled back to now: the rule the worker applies. */
async function startService(): Promise<FakeSettingsService> {
    const state: FakeSettingsService = {origin: '', settings: {}, clock: () => Date.now(), available: true, calls: [], close: async () => {}};
    const server: Server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(chunk as Buffer);
        }
        state.calls.push(`${request.method} ${request.url}`);
        const send = (status: number, value: unknown) => {
            response.writeHead(status, {'content-type': 'application/json'});
            response.end(JSON.stringify(value));
        };
        if (!state.available || request.url !== SETTINGS_PATH) {
            return send(404, {error: {message: 'Unknown endpoint'}});
        }
        if (request.headers['x-pairlobby-account-token'] !== TOKEN) {
            return send(401, {error: {message: 'Run pairlobby login first'}});
        }
        if (request.method === 'PUT') {
            try {
                for (const change of parseAccountSettingChanges(JSON.parse(Buffer.concat(chunks).toString('utf8')))) {
                    const updatedAt = Math.min(change.updatedAt, state.clock());
                    const existing = state.settings[change.field];
                    if (!existing || updatedAt >= existing.updatedAt) {
                        state.settings[change.field] = {value: change.value, updatedAt};
                    }
                }
            } catch (error) {
                return send(400, {error: {message: error instanceof AccountSettingsError ? error.message : 'bad request'}});
            }
        }
        send(200, {settings: state.settings, serverTime: state.clock()});
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    state.close = () => new Promise((resolveClose) => server.close(() => resolveClose()));
    return state;
}

let directory: string;
let service: FakeSettingsService;

function device(name: string): LocalStore {
    const store = new LocalStore(join(directory, name));
    store.putCredential('online-account', service.origin, TOKEN);
    return store;
}

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-settings-sync-'));
    service = await startService();
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', service.origin);
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', '');
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await service.close();
    rmSync(directory, {recursive: true, force: true});
});

test('test_nothing_syncs_until_it_is_turned_on', async () => {
    const laptop = device('laptop');
    laptop.setSettings({showIds: true});
    expect(await syncSettings(laptop)).toBeNull();
    expect(await pushSettings(laptop)).toBeNull();
    expect(service.calls).toEqual([]);
    expect(syncStatus(laptop)).toMatchObject({loggedIn: true, enabled: false, pending: []});
});

test('test_a_second_device_takes_the_account_settings_or_sends_its_own', async () => {
    const laptop = device('laptop');
    laptop.setSettings({defaultTurnMode: 'parallel', showIds: true});
    laptop.setProfile({displayName: 'alex'});
    await enableSync(laptop, 'device');
    expect(Object.keys(service.settings)).toHaveLength(14);
    expect(service.settings.defaultTurnMode?.value).toBe('parallel');
    expect(service.settings.displayName?.value).toBe('alex');

    const desktop = device('desktop');
    desktop.setSettings({confirmDelete: false});
    const document = parseDocument(await (await fetch(service.origin + SETTINGS_PATH, {headers: {'x-pairlobby-account-token': TOKEN}})).json());
    expect(settingDifferences(desktop, document).map((difference) => difference.field).sort()).toEqual(['confirmDelete', 'defaultTurnMode', 'displayName', 'showIds']);
    const outcome = await enableSync(desktop, 'account', document);
    expect(outcome.applied.sort()).toEqual(['confirmDelete', 'defaultTurnMode', 'displayName', 'showIds']);
    expect(desktop.accountSettingValues()).toEqual(laptop.accountSettingValues());
    expect(pendingSettings(desktop)).toEqual([]);

    const tablet = device('tablet');
    tablet.setSettings({deleteEmptyRooms: false});
    await enableSync(tablet, 'device');
    expect(service.settings.deleteEmptyRooms?.value).toBe(false);
    expect(service.settings.defaultTurnMode?.value).toBe('sequential');
});

function parseDocument(value: unknown) {
    return value as {settings: AccountSettingsMap; serverTime: number};
}

test('test_edits_to_different_settings_on_two_devices_both_survive', async () => {
    const laptop = device('laptop');
    const desktop = device('desktop');
    await enableSync(laptop, 'device');
    await enableSync(desktop, 'account');

    laptop.setSettings({defaultTurnMode: 'parallel'});
    await pushSettings(laptop);
    desktop.setSettings({showIds: true});
    await pushSettings(desktop);

    await syncSettings(laptop);
    await syncSettings(desktop);
    expect(laptop.accountSettingValues()).toMatchObject({defaultTurnMode: 'parallel', showIds: true});
    expect(desktop.accountSettingValues()).toMatchObject({defaultTurnMode: 'parallel', showIds: true});
});

test('test_the_most_recent_change_to_one_setting_wins', async () => {
    const laptop = device('laptop');
    const desktop = device('desktop');
    await enableSync(laptop, 'device');
    await enableSync(desktop, 'account');

    service.clock = () => Date.now() + 60_000;
    laptop.setSettings({defaultInviteRole: 'guest'}, service.clock() - 20);
    desktop.setSettings({defaultInviteRole: 'guest'}, service.clock() - 10);
    desktop.setSettings({defaultInviteRole: 'member'}, service.clock() - 10);
    await pushSettings(desktop);
    expect(service.settings.defaultInviteRole).toEqual({value: 'member', updatedAt: expect.any(Number)});
    await pushSettings(laptop);
    expect(service.settings.defaultInviteRole?.value).toBe('member');
    expect(laptop.accountSettingValues().defaultInviteRole).toBe('member');
    expect(pendingSettings(laptop)).toEqual([]);
});

test('test_an_offline_change_waits_and_beats_an_older_account_value', async () => {
    const laptop = device('laptop');
    await enableSync(laptop, 'device');
    service.settings.showIds = {value: false, updatedAt: service.clock() - 60_000};
    service.available = false;
    laptop.setSettings({showIds: true});
    await expect(pushSettings(laptop)).rejects.toThrow(/does not keep settings/);
    expect(pendingSettings(laptop)).toEqual(['showIds']);
    expect(syncStatus(laptop).pending).toEqual(['showIds']);

    service.available = true;
    const outcome = await syncSettings(laptop);
    expect(outcome).toEqual({applied: [], sent: ['showIds']});
    expect(service.settings.showIds?.value).toBe(true);
    expect(pendingSettings(laptop)).toEqual([]);
});

test('test_a_device_with_a_slow_clock_still_wins_with_a_later_change', async () => {
    const laptop = device('laptop');
    const ahead = 3_600_000;
    service.clock = () => Date.now() + ahead;
    await enableSync(laptop, 'device');
    service.settings.confirmDelete = {value: true, updatedAt: service.clock() - 1000};
    laptop.setSettings({confirmDelete: false});
    await pushSettings(laptop);
    expect(service.settings.confirmDelete?.value).toBe(false);
});

test('test_linked_managed_limits_are_sent_together', async () => {
    const laptop = device('laptop');
    await enableSync(laptop, 'device');
    laptop.setSettings({managedTaskIdleMs: 5 * 60_000});
    expect(pendingSettings(laptop)).toEqual(['managedTaskIdleMs', 'managedTaskTimeoutMs']);
    await pushSettings(laptop);
    expect(service.settings.managedTaskIdleMs?.value).toBe(5 * 60_000);
    expect(service.settings.managedTaskIdleMs?.updatedAt).toBe(service.settings.managedTaskTimeoutMs?.updatedAt);
});

test('test_turning_sync_off_keeps_this_device_values', async () => {
    const laptop = device('laptop');
    await enableSync(laptop, 'device');
    expect(disableSync(laptop)).toBe(true);
    expect(disableSync(laptop)).toBe(false);
    laptop.setSettings({showIds: true});
    expect(await pushSettings(laptop)).toBeNull();
    expect(laptop.accountSettingValues().showIds).toBe(true);
});

test('test_login_asks_and_shows_differences', async () => {
    const said: string[] = [];
    const laptop = device('laptop');
    const asked: string[] = [];
    expect(await offerSettingsSync(laptop, {ask: async (question) => (asked.push(question), ''), say: (line) => said.push(line)})).not.toBeNull();
    expect(asked[0]).toMatch(/Sync this device's settings with your account/);
    expect(syncStatus(laptop).enabled).toBe(true);

    service.settings.showIds = {value: true, updatedAt: service.clock()};
    const desktop = device('desktop');
    const outcome = await offerSettingsSync(desktop, {ask: async () => 'a', say: (line) => said.push(line)});
    expect(said).toContain('  Show IDs: this device off, account on');
    expect(outcome?.applied).toEqual(['showIds']);

    const tablet = device('tablet');
    expect(await offerSettingsSync(tablet, {ask: async () => 'n', say: (line) => said.push(line)})).toBeNull();
    expect(syncStatus(tablet).enabled).toBe(false);
});

test('test_login_skips_quietly_when_the_service_has_no_settings', async () => {
    service.available = false;
    const said: string[] = [];
    const laptop = device('laptop');
    expect(await offerSettingsSync(laptop, {ask: async () => 'y', say: (line) => said.push(line)})).toBeNull();
    expect(said).toEqual([]);
    expect(syncStatus(laptop).enabled).toBe(false);
});

test('test_the_cli_turns_sync_on_and_sends_each_change_right_away', async () => {
    const run = promisify(execFile);
    const env = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'cli'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_ONLINE_ORIGIN: service.origin, PAIRLOBBY_ACCOUNT_TOKEN: TOKEN, CLAUDE_CODE_SESSION_ID: ''};
    const cli = (args: string[]) => run(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env, timeout: 15_000});
    expect(JSON.parse((await cli(['settings', 'sync', 'status', '--json'])).stdout)).toMatchObject({loggedIn: true, enabled: false});
    service.settings.showIds = {value: true, updatedAt: service.clock()};
    await expect(cli(['settings', 'sync', 'on', '--json'])).rejects.toThrow(/pass --from account or --from device/);
    expect(JSON.parse((await cli(['settings', 'sync', 'on', '--from', 'account', '--json'])).stdout)).toMatchObject({enabled: true, applied: ['showIds']});
    const changed = await cli(['settings', 'default-reply-mode', 'parallel']);
    expect(changed.stderr).toMatch(/synced with your/);
    expect(service.settings.defaultTurnMode?.value).toBe('parallel');
    await cli(['profile', '--as', 'alex']);
    expect(service.settings.displayName?.value).toBe('alex');
    expect((await cli(['settings', 'sync', 'off'])).stdout).toMatch(/Settings sync is off/);
    await cli(['settings', 'show-ids', 'off']);
    expect(service.settings.showIds?.value).toBe(true);
});

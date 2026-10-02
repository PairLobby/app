import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {DEFAULT_SETTINGS, LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {SETTING_KEYS, describeSettingValue, deviceSettingsPage, parseSettingValue} from './device-settings.js';
import type {PanelEdit} from './room-panel.js';

type CreatedJson = {roomId: string; sessionId: string};

const execute = promisify(execFile);
let directory: string;
let server: RunningServer;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-device-settings-'));
    server = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
});

afterEach(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(args: string[]): Promise<string> {
    const {stdout} = await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'client'), PAIRLOBBY_NO_UPDATE_CHECK: '1'}, timeout: 15_000});
    return stdout;
}

test('test_setting_values_accept_short_names_and_reject_others', () => {
    const invites = SETTING_KEYS['default-invites']!;
    expect(parseSettingValue('default-invites', invites, 'observer')).toBe('guest');
    expect(parseSettingValue('default-invites', invites, 'Member')).toBe('member');
    expect(parseSettingValue('default-guest-access', SETTING_KEYS['default-guest-access']!, 'open')).toBe('open_to_guests');
    expect(parseSettingValue('default-reply-mode', SETTING_KEYS['default-reply-mode']!, 'parallel')).toBe('parallel');
    expect(() => parseSettingValue('default-reply-mode', SETTING_KEYS['default-reply-mode']!, 'chaos')).toThrow('sequential or parallel');
    expect(parseSettingValue('default-expiry', SETTING_KEYS['default-expiry']!, 'never')).toBeNull();
    expect(describeSettingValue(invites, 'guest')).toBe('Read-only observers');
    expect(describeSettingValue(SETTING_KEYS['auto-update']!, true)).toBe('On');
});

test('test_the_menu_lists_every_setting_and_saves_edits_immediately', async () => {
    const store = new LocalStore(join(directory, 'menu'));
    const page = deviceSettingsPage(store);
    expect(page.rows.map((row) => row.id)).toEqual(['profile-name', ...Object.keys(SETTING_KEYS), 'reset']);
    expect(new Set(page.rows.map((row) => row.section))).toEqual(new Set(['Profile', 'New rooms', 'Terminal', 'Updates', 'Reset']));
    const edit = (id: string) => page.rows.find((row) => row.id === id)!.action as PanelEdit;
    expect(edit('default-reply-mode').choices?.map((choice) => choice.value)).toEqual(['sequential', 'parallel']);
    await edit('default-reply-mode').save('parallel');
    await edit('auto-update').save('true');
    await edit('default-expiry').save('24h');
    await edit('profile-name').save('Hugo');
    expect(store.settings()).toMatchObject({defaultTurnMode: 'parallel', autoUpdate: true, defaultRoomLifetimeMs: 86_400_000});
    expect(store.profile().displayName).toBe('Hugo');
    await expect(edit('poll-interval').save('-3')).rejects.toThrow('positive number');
    await edit('profile-name').save('');
    expect(store.profile().displayName).toBeUndefined();
    expect(deviceSettingsPage(store).rows.find((row) => row.id === 'default-reply-mode')!.value).toBe('Parallel');
});

test('test_new_rooms_start_with_this_devices_defaults', async () => {
    await cli(['settings', 'default-reply-mode', 'parallel']);
    await cli(['settings', 'default-invites', 'observer']);
    await cli(['settings', 'default-guest-access', 'open']);
    const created = JSON.parse(await cli(['create', '--name', 'defaults', '--as', 'owner', '--human', '--server', server.url, '--json'])) as CreatedJson;
    const store = new LocalStore(join(directory, 'client'));
    const client = new PairLobbyClient(server.url);
    const credential = store.credential(created.roomId, created.sessionId)!;
    const room = await client.snapshot(created.roomId, credential);
    expect(room.policy).toMatchObject({inviteRole: 'guest', joinPolicy: 'open_to_guests'});
    expect((await client.turnQueue(created.roomId, credential)).mode).toBe('parallel');
    expect(store.settings()).toEqual({...DEFAULT_SETTINGS, defaultTurnMode: 'parallel', defaultInviteRole: 'guest', defaultGuestAccess: 'open_to_guests'});
});

test('test_private_and_public_only_apply_to_online_rooms', async () => {
    await expect(cli(['create', '--name', 'local', '--public', '--server', server.url])).rejects.toMatchObject({stderr: expect.stringContaining('apply to online rooms')});
    await expect(cli(['create', 'online', '--name', 'both', '--private', '--public'])).rejects.toMatchObject({stderr: expect.stringContaining('either --private or --public')});
});

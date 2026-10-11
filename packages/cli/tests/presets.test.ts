import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {afterAll, beforeAll, expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import type {CreatedRoom} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

import {runPresetCommand} from '../src/presets.js';
import type {PresetCommandContext} from '../src/presets.js';

const execute = promisify(execFile);
const directory = mkdtempSync(join(tmpdir(), 'pairlobby-presets-'));
let server: RunningServer;
let client: PairLobbyClient;
let store: LocalStore;

beforeAll(async () => {
    server = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
    client = new PairLobbyClient(server.url);
    store = new LocalStore(join(directory, 'device'));
});

afterAll(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

function ownerContext(room: CreatedRoom): PresetCommandContext {
    return {client, store, roomId: room.roomId, credential: room.participantCredential, controllerCredential: room.controllerCredential, participantId: room.participantId};
}

async function configuredRoom(): Promise<CreatedRoom> {
    const room = await client.createRoom('source', {displayName: 'owner', kind: 'human'});
    await client.setRoomPermissions(room.roomId, room.controllerCredential, {invite: false, mute: true});
    await client.setTurnMode(room.roomId, room.controllerCredential, 'parallel');
    await client.setInviteRole(room.roomId, room.controllerCredential, 'guest');
    await client.setAutoClose(room.roomId, room.controllerCredential, {mode: 'inactivity', afterMs: 7_200_000});
    return room;
}

test('test_a_preset_saves_configuration_only_and_shows_its_changes_before_applying_them', async () => {
    const source = await configuredRoom();
    const maria = await client.redeemInvite((await client.mintInvite(source.roomId, source.controllerCredential, 'member')).code, {displayName: 'maria', kind: 'human'});
    await client.setParticipantPermissions(source.roomId, source.controllerCredential, maria.participantId, {kick: true});

    expect(await runPresetCommand('save strict', ownerContext(source))).toContain('Saved preset strict from this room.');
    const saved = readFileSync(join(directory, 'device', 'presets.json'), 'utf8');
    expect(JSON.parse(saved).presets[0]).toMatchObject({name: 'strict', permissions: {invite: false, mute: true}, turnMode: 'parallel', inviteRole: 'guest', autoClose: {mode: 'inactivity', afterMs: 7_200_000}});
    for (const secret of [source.controllerCredential, source.participantCredential, source.roomId, maria.participantId, 'kick']) {
        expect(saved).not.toContain(secret);
    }

    const target = await client.createRoom('target', {displayName: 'owner', kind: 'human'});
    const proposal = await runPresetCommand('apply strict', ownerContext(target));
    expect(proposal).toContain('Command permissions: members may invite → members may mute');
    expect(proposal).toContain('Reply mode: sequential → parallel');
    expect(proposal).toContain('Run /preset apply strict confirm to apply.');
    expect((await client.snapshot(target.roomId, target.participantCredential)).policy.permissions).toBeUndefined();

    expect(await runPresetCommand('apply strict confirm', ownerContext(target))).toContain('Applied preset strict:');
    const applied = await client.snapshot(target.roomId, target.participantCredential);
    expect(applied.policy).toMatchObject({permissions: {invite: false, mute: true}, inviteRole: 'guest', autoClose: {mode: 'inactivity', afterMs: 7_200_000}});
    expect(applied.turnMode).toBe('parallel');
    expect(await runPresetCommand('apply strict', ownerContext(target))).toBe('This room already matches preset strict.');
});

test('test_only_the_owner_or_an_admin_applies_a_preset_and_names_are_checked', async () => {
    const room = await client.createRoom('guarded', {displayName: 'owner', kind: 'human'});
    const maria = await client.redeemInvite(room.invite.code, {displayName: 'maria', kind: 'human'});
    const member: PresetCommandContext = {client, store, roomId: room.roomId, credential: maria.participantCredential, participantId: maria.participantId};
    await runPresetCommand('save strict', ownerContext(await configuredRoom()));

    await expect(runPresetCommand('apply strict confirm', member)).rejects.toThrow('only the room owner and admins apply a preset');
    expect((await client.snapshot(room.roomId, maria.participantCredential)).turnMode).toBe('sequential');
    await expect(runPresetCommand('apply missing', member)).rejects.toThrow('No preset named missing');
    await expect(runPresetCommand('save none', member)).rejects.toThrow('A preset name is');
    await expect(runPresetCommand('save two words', member)).rejects.toThrow('Usage: /preset');
    // Saving reads the room and writes this device only, so any member may do it.
    expect(await runPresetCommand('save Mine', member)).toContain('Saved preset Mine');
    expect(await runPresetCommand('save mine', member)).toContain('Updated preset mine');
    expect(store.presets().filter((preset) => preset.name.toLowerCase() === 'mine')).toHaveLength(1);
});

test('test_a_default_preset_starts_new_rooms_and_never_changes_existing_ones', async () => {
    const existing = await client.createRoom('existing', {displayName: 'owner', kind: 'human'});
    await runPresetCommand('save strict', ownerContext(await configuredRoom()));
    expect(await runPresetCommand('default strict', ownerContext(existing))).toContain('Rooms this device creates now start with preset strict. Existing rooms are not changed.');
    expect(await runPresetCommand('list', ownerContext(existing))).toContain('strict (default for new rooms)');
    expect((await client.snapshot(existing.roomId, existing.participantCredential)).policy.permissions).toBeUndefined();

    const cli = async (...args: string[]) => (await execute(process.execPath, [process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js'), ...args], {env: {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1'}})).stdout;
    const created = JSON.parse(await cli('create', '--name', 'from-default', '--as', 'owner', '--human', '--server', server.url, '--manual-receive', '--json'));
    const started = await client.snapshot(created.roomId, store.credential(created.roomId, 'controller')!);
    expect(started.policy).toMatchObject({permissions: {invite: false, mute: true}, inviteRole: 'guest'});
    expect(started.turnMode).toBe('parallel');

    const plain = JSON.parse(await cli('create', '--name', 'plain', '--as', 'owner', '--human', '--server', server.url, '--manual-receive', '--preset', 'none', '--json'));
    const untouched = await client.snapshot(plain.roomId, store.credential(plain.roomId, 'controller')!);
    expect(untouched.policy.permissions).toBeUndefined();
    expect(untouched.turnMode).toBe('sequential');
    await expect(cli('create', '--name', 'nope', '--server', server.url, '--preset', 'missing')).rejects.toThrow('no preset named missing');

    expect(await cli('presets', 'show', 'strict')).toContain('Command permissions  members may mute');
    expect(await runPresetCommand('delete strict', ownerContext(existing))).toContain('Preset strict deleted');
    expect(store.defaultPreset()).toBeUndefined();
    expect(await runPresetCommand('default none', ownerContext(existing))).toContain('built-in defaults');
});

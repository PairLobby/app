import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, beforeAll, expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import type {CreatedRoom, JoinedRoom} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {applyPermissionChange, effectivePermissions, newCredential, newId, roomPermissions} from '@pairlobby/protocol';

import {runRoomCommand} from '../src/chat-commands.js';
import type {RoomCommandContext} from '../src/chat-commands.js';
import {parsePermissionCommand} from '../src/permissions.js';
import type {PanelEdit, PanelMenu, RoomPanelPage} from '../src/room-panel.js';
import {settingsPage} from '../src/room-settings.js';

type Joiner = {member: JoinedRoom; context: RoomCommandContext};

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-permissions-'));
const dataFile = join(directory, 'rooms.sqlite');
let server: RunningServer;
let client: PairLobbyClient;

beforeAll(async () => {
    server = await startServer({port: 0, dataFile});
    client = new PairLobbyClient(server.url);
});

afterAll(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

function ownerContext(room: CreatedRoom): RoomCommandContext {
    return {client, roomId: room.roomId, credential: room.participantCredential, controllerCredential: room.controllerCredential, participantId: room.participantId};
}

async function admit(room: CreatedRoom, name: string, kind: 'human' | 'agent' = 'human'): Promise<Joiner> {
    const invite = await client.mintInvite(room.roomId, room.controllerCredential, 'member', true);
    const member = await client.redeemInvite(invite.code, {displayName: name, kind}, {attemptId: newId('attempt'), participantCredential: newCredential('participant')});
    return {member, context: {client, roomId: room.roomId, credential: member.participantCredential, participantId: member.participantId}};
}

async function open(page: RoomPanelPage, id: string): Promise<RoomPanelPage> {
    return (page.rows.find((row) => row.id === id)!.action as PanelMenu).load();
}

test('test_settings_pages_edit_room_and_member_permissions_and_give_an_allowed_member_the_control', async () => {
    const room = await client.createRoom('panel', {displayName: 'owner', kind: 'human'});
    const owner = ownerContext(room);
    const {context: maria} = await admit(room, 'maria');
    const {context: joe} = await admit(room, 'joe');

    const settings = await settingsPage(owner);
    expect(settings.rows.find((row) => row.id === 'permissions')?.value).toBe('Members may: invite, attach');
    const permissions = await open(settings, 'permissions');
    expect(permissions.rows.find((row) => row.id === 'mute')?.value).toBe('Owner and admins only (default)');
    await (permissions.rows.find((row) => row.id === 'invite')!.action as PanelEdit).save('deny');
    expect((await permissions.reload()).rows.find((row) => row.id === 'invite')?.value).toBe('Owner and admins only');

    // A member sees the same pages read-only, and no control they are not allowed.
    const readOnly = await open(await settingsPage(maria), 'permissions');
    expect(readOnly.rows.every((row) => row.action === undefined)).toBe(true);
    const before = await open(await open(await settingsPage(maria), 'members'), joe.participantId);
    expect(before.rows.find((row) => row.id === 'mute')?.action).toBeUndefined();

    const member = await open(await open(await settingsPage(owner), 'members'), maria.participantId);
    await (member.rows.find((row) => row.id === 'permission-mute')!.action as PanelEdit).save('allow');
    expect((await member.reload()).rows.find((row) => row.id === 'permission-mute')?.value).toBe('Allowed');
    expect((await member.reload()).rows.find((row) => row.id === 'permission-invite')?.value).toBe('Not allowed (room setting)');

    const after = await open(await open(await settingsPage(maria), 'members'), joe.participantId);
    const mute = after.rows.find((row) => row.id === 'mute')!.action;
    expect(after.rows.find((row) => row.id === 'kick')?.action).toBeUndefined();
    await (mute as {run: () => Promise<void>}).run();
    expect((await client.snapshot(room.roomId, joe.credential)).participants.find((person) => person.participantId === joe.participantId)?.muted).toBe(true);
});

test('test_effective_permissions_put_a_members_own_decision_before_the_rooms_and_never_limit_admins', () => {
    expect(roomPermissions(undefined)).toEqual({invite: true, attach: true, rename: false, lock: false, mute: false, kick: false, pause: false, turns: false});
    expect(effectivePermissions({role: 'member'}, {invite: false, lock: true}).invite).toBe(false);
    expect(effectivePermissions({role: 'member', permissions: {invite: true, lock: false}}, {invite: false, lock: true})).toMatchObject({invite: true, lock: false});
    expect(Object.values(effectivePermissions({role: 'controller'}, {invite: false})).every(Boolean)).toBe(true);
    expect(Object.values(effectivePermissions({role: 'guest', permissions: {invite: true}}, {invite: true})).some(Boolean)).toBe(false);
    expect(applyPermissionChange({invite: false, lock: true}, {invite: null, kick: true})).toEqual({lock: true, kick: true});
});

test('test_permission_command_parsing_accepts_several_commands_all_and_a_name_with_spaces', () => {
    expect(parsePermissionCommand('allow kick mute @maria')).toEqual({action: 'allow', permissions: ['kick', 'mute'], target: '@maria'});
    expect(parsePermissionCommand('deny invite')).toEqual({action: 'deny', permissions: ['invite'], target: ''});
    expect(parsePermissionCommand('reset all for build agent').target).toBe('build agent');
    expect(parsePermissionCommand('reset all').permissions).toHaveLength(8);
    expect(() => parsePermissionCommand('grant kick')).toThrow('Usage: /permissions');
    expect(() => parsePermissionCommand('allow nothing')).toThrow('Usage: /permissions');
});

test('test_moderation_stays_with_the_owner_until_a_command_is_allowed_and_ends_when_it_is_taken_back', async () => {
    const room = await client.createRoom('grants', {displayName: 'owner', kind: 'human'});
    const owner = ownerContext(room);
    const {context: maria} = await admit(room, 'maria');
    const {context: joe} = await admit(room, 'joe');

    await expect(runRoomCommand('/lock', maria)).rejects.toThrow('does not let you lock');
    await expect(client.setLocked(room.roomId, maria.credential, true)).rejects.toThrow('does not let you lock');
    await expect(client.setMuted(room.roomId, maria.credential, joe.participantId, true)).rejects.toThrow('does not let you mute');
    await expect(client.revoke(room.roomId, maria.credential, joe.participantId)).rejects.toThrow('does not let you remove');
    await expect(client.rename(room.roomId, maria.credential, 'mine now')).rejects.toThrow('does not let you rename');

    expect(await runRoomCommand('/permissions allow mute lock maria', owner)).toBe('maria may now lock and unlock the room, mute and unmute participants');
    expect(await runRoomCommand('/mute joe', maria)).toBe('joe was muted.');
    expect(await runRoomCommand('/lock', maria)).toContain('Room locked');
    await runRoomCommand('/unlock', maria);
    // One member's allowance is not everyone's, and it covers only the commands named.
    await expect(runRoomCommand('/unmute joe', joe)).rejects.toThrow();
    await expect(runRoomCommand('/kick joe', maria)).rejects.toThrow('does not let you remove');

    expect(await runRoomCommand('/permissions reset mute maria', owner)).toBe('maria follows the room\'s setting again for: mute');
    await expect(runRoomCommand('/unmute joe', maria)).rejects.toThrow('does not let you mute');
    expect(await runRoomCommand('/unmute joe', owner)).toBe('joe was unmuted.');
});

test('test_a_room_wide_permission_covers_every_member_and_one_member_can_still_be_refused', async () => {
    const room = await client.createRoom('room-wide', {displayName: 'owner', kind: 'human'});
    const owner = ownerContext(room);
    const {context: maria} = await admit(room, 'maria');
    const {context: joe} = await admit(room, 'joe');
    const {member: agent} = await admit(room, 'codex', 'agent');

    expect(await runRoomCommand('/permissions allow pause', owner)).toBe('members may now pause, resume and interrupt agents');
    expect(await runRoomCommand('/permissions deny pause joe', owner)).toBe('joe may no longer pause, resume and interrupt agents');
    await expect(client.control(room.roomId, maria.credential, agent.participantId, true)).resolves.toMatchObject({revision: 1});
    await expect(client.interrupt(room.roomId, maria.credential, agent.participantId)).resolves.toBeDefined();
    await expect(client.control(room.roomId, joe.credential, agent.participantId, false)).rejects.toThrow('does not let you pause');

    const report = await runRoomCommand('/permissions', maria);
    expect(report).toContain('pause   members — pause, resume and interrupt agents');
    expect(report).toContain('kick    owner and admins only (default)');
    expect(report).toContain('joe: pause not allowed');

    const events = (await client.readEvents(room.roomId, maria.credential, 0)).events;
    expect(events.find((event) => event.type === 'room.permissions_changed')?.payload).toEqual({permissions: {pause: true}, previous: {}});
    expect(events.find((event) => event.type === 'participant.permissions_changed')?.payload).toEqual({participantId: joe.participantId, permissions: {pause: false}, previous: {}});
});

test('test_invites_can_be_turned_off_for_members_and_only_admins_change_permissions', async () => {
    const room = await client.createRoom('no-invites', {displayName: 'owner', kind: 'human'});
    const owner = ownerContext(room);
    const {context: maria} = await admit(room, 'maria');

    expect(await runRoomCommand('/invite', maria)).toContain('Invite: ');
    expect(await runRoomCommand('/permissions deny invite', owner)).toBe('only the owner and admins may now create invites');
    await expect(runRoomCommand('/invite', maria)).rejects.toThrow('does not let you create invites');
    await expect(client.mintInvite(room.roomId, maria.credential)).rejects.toThrow('does not let you create invites');
    expect(await runRoomCommand('/invite', owner)).toContain('Invite: ');

    await expect(runRoomCommand('/permissions allow invite', maria)).rejects.toThrow('only the room owner and admins change command permissions');
    await expect(client.setRoomPermissions(room.roomId, maria.credential, {invite: true})).rejects.toThrow('requires the room controller credential');
    await expect(client.setParticipantPermissions(room.roomId, maria.credential, maria.participantId, {kick: true})).rejects.toThrow('requires the room controller credential');
    // Changing nothing records nothing.
    const before = (await client.snapshot(room.roomId, owner.credential)).latestSeq;
    await client.setRoomPermissions(room.roomId, room.controllerCredential, {invite: false});
    expect((await client.snapshot(room.roomId, owner.credential)).latestSeq).toBe(before);
});

test('test_a_permission_never_reaches_an_admin_an_observer_or_a_demoted_admin', async () => {
    const room = await client.createRoom('limits', {displayName: 'owner', kind: 'human'});
    const owner = ownerContext(room);
    const {context: maria} = await admit(room, 'maria');
    const {context: admin} = await admit(room, 'ada');
    await client.setRole(room.roomId, room.controllerCredential, admin.participantId, 'controller');
    await runRoomCommand('/permissions allow kick mute', owner);

    await expect(client.revoke(room.roomId, maria.credential, admin.participantId)).rejects.toThrow('only the room owner or another admin');
    await expect(client.setMuted(room.roomId, maria.credential, admin.participantId, true)).rejects.toThrow('only the room owner or another admin');
    await expect(runRoomCommand('/permissions deny kick ada', owner)).rejects.toThrow('Admins can already use every command');

    const observer = await client.redeemInvite((await client.mintInvite(room.roomId, room.controllerCredential, 'guest')).code, {displayName: 'reader', kind: 'human'});
    await expect(client.setMuted(room.roomId, observer.participantCredential, maria.participantId, true)).rejects.toThrow('guests can read this room');
    await expect(runRoomCommand('/permissions allow mute reader', owner)).rejects.toThrow('read-only observer cannot use room commands');

    // An allowance held as a member does not come back after being an admin.
    await runRoomCommand('/permissions deny kick mute', owner);
    await runRoomCommand('/permissions allow kick maria', owner);
    await client.setRole(room.roomId, room.controllerCredential, maria.participantId, 'controller');
    const demoted = await client.setRole(room.roomId, room.controllerCredential, maria.participantId, 'member');
    expect(demoted.participants.find((person) => person.participantId === maria.participantId)?.permissions).toBeUndefined();
    await expect(client.revoke(room.roomId, maria.credential, admin.participantId)).rejects.toThrow('does not let you remove');
});

test('test_a_refusal_survives_leaving_and_rejoining_on_the_same_invite_and_a_relay_restart', async () => {
    const room = await client.createRoom('persistent', {displayName: 'owner', kind: 'human'});
    const owner = ownerContext(room);
    const invite = await client.mintInvite(room.roomId, room.controllerCredential, 'member', true);
    const first = await client.redeemInvite(invite.code, {displayName: 'maria', kind: 'human'});
    await runRoomCommand('/permissions allow lock maria', owner);
    await runRoomCommand('/permissions deny invite maria', owner);
    await client.leave(room.roomId, first.participantCredential);

    const again = await client.redeemInvite(invite.code, {displayName: 'someone else', kind: 'human'});
    const seat = (await client.snapshot(room.roomId, again.participantCredential)).participants.find((person) => person.participantId === again.participantId);
    expect(seat?.permissions).toEqual({invite: false});
    await expect(client.mintInvite(room.roomId, again.participantCredential)).rejects.toThrow('does not let you create invites');
    await expect(client.setLocked(room.roomId, again.participantCredential, true)).rejects.toThrow('does not let you lock');

    await runRoomCommand('/permissions allow rename', owner);
    await server.close();
    server = await startServer({port: 0, dataFile});
    client = new PairLobbyClient(server.url);
    const restored = await client.snapshot(room.roomId, again.participantCredential);
    expect(restored.permissionsSupported).toBe(true);
    expect(restored.policy.permissions).toEqual({rename: true});
    expect(restored.participants.find((person) => person.participantId === again.participantId)?.permissions).toEqual({invite: false});
    await expect(client.rename(room.roomId, again.participantCredential, 'renamed by a member')).resolves.toBeDefined();
});

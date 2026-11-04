//! Room visibility on a relay with personal tokens: a room is its owner's default, everyone, or a
//! list of handles. It decides who finds a room by name and whom a member's code lets in; the
//! owner's own codes admit whoever the owner gives them to.

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {PairLobbyClient} from '@pairlobby/client';
import type {CreatedRoom} from '@pairlobby/client';
import {canSee, resolveVisibility} from '@pairlobby/protocol';
import type {RoomVisibility} from '@pairlobby/protocol';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {issueMemberToken} from '../src/members.js';
import {startServer} from '../src/server.js';
import type {RunningServer} from '../src/server.js';

const HANDLES = ['damien', 'dlambla', 'xavi', 'yann', 'zoe', 'omar'] as const;
type Handle = typeof HANDLES[number];

let directory: string;
let relay: RunningServer;
let tokens: Record<Handle, string>;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-room-visibility-'));
    const issued = await Promise.all(HANDLES.map((handle) => issueMemberToken(handle)));
    const members = join(directory, 'members.jsonl');
    writeFileSync(members, issued.map((member) => `${JSON.stringify(member.line)}\n`).join(''));
    tokens = Object.fromEntries(HANDLES.map((handle, index) => [handle, issued[index]!.token])) as Record<Handle, string>;
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite'), trustedProxyHeader: 'x-forwarded-for', members: {file: members}, discovery: {loginMode: 'token', name: 'Example Corp PairLobby'}});
});

afterEach(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

function as(handle: Handle): PairLobbyClient {
    return new PairLobbyClient(relay.url, tokens[handle]);
}

/** The names of the rooms this member finds by name. */
async function found(handle: Handle): Promise<string[]> {
    return ((await as(handle).localRooms()) ?? []).map((room) => room.name).sort();
}

function create(name: string, visibility?: RoomVisibility): Promise<CreatedRoom> {
    return as('damien').createRoom(name, {displayName: 'damien', kind: 'human'}, undefined, undefined, 'public', visibility);
}

test('test_visibility_resolves_through_the_owner_default_and_a_room_without_an_owner_is_seen_by_everyone', () => {
    const owner = 'damien';
    expect(resolveVisibility({visibility: 'default'}, {handles: ['zoe']})).toBe('everyone');
    expect(resolveVisibility({owner, visibility: 'default'}, null)).toBe('everyone');
    expect(resolveVisibility({owner}, {handles: ['zoe']})).toEqual({handles: ['zoe']});
    expect(canSee({owner, visibility: {handles: ['zoe']}}, null, 'damien')).toBe(true);
    expect(canSee({owner, visibility: {handles: ['zoe']}}, null, null)).toBe(false);
    expect(canSee({owner, visibility: 'everyone'}, {handles: ['zoe']}, null)).toBe(true);
});

test('test_r1_to_r3_follow_their_own_setting_or_the_owner_default_and_changing_the_default_changes_only_r3', async () => {
    expect(await as('damien').setMemberDefault({handles: ['dlambla', 'xavi', 'yann', 'zoe']})).toEqual({handles: ['dlambla', 'xavi', 'yann', 'zoe']});
    await create('r1', 'everyone');
    await create('r2', {handles: ['zoe']});
    await create('r3');
    expect(await found('damien')).toEqual(['r1', 'r2', 'r3']);
    expect(await found('dlambla')).toEqual(['r1', 'r3']);
    expect(await found('zoe')).toEqual(['r1', 'r2', 'r3']);
    expect(await found('omar')).toEqual(['r1']);

    await as('damien').setMemberDefault({handles: ['omar']});
    expect(await found('dlambla')).toEqual(['r1']);
    expect(await found('zoe')).toEqual(['r1', 'r2']);
    expect(await found('omar')).toEqual(['r1', 'r3']);
    expect(await as('omar').memberDefault()).toBe('everyone');
});

test('test_a_member_code_admits_only_someone_who_sees_the_room_and_the_owner_code_admits_whoever_has_it', async () => {
    const room = await create('r2', {handles: ['zoe']});
    const zoe = await as('zoe').joinOnLocalNetwork(room.roomId, {displayName: 'zoe', kind: 'human'});
    await expect(as('omar').joinOnLocalNetwork(room.roomId, {displayName: 'omar', kind: 'human'})).rejects.toThrow('has not let you see this room');

    const fromZoe = await as('zoe').mintInvite(room.roomId, zoe.participantCredential, 'member', false);
    await expect(as('omar').redeemInvite(fromZoe.code, {displayName: 'omar', kind: 'human'})).rejects.toThrow('has not let you see this room');
    const changed = await as('damien').setVisibility(room.roomId, room.controllerCredential, 'everyone');
    expect(changed.event?.type).toBe('room.visibility_changed');
    expect((await as('damien').setVisibility(room.roomId, room.controllerCredential, 'everyone')).event).toBeNull();
    expect((await as('omar').redeemInvite(fromZoe.code, {displayName: 'omar', kind: 'human'})).role).toBe('member');

    await as('damien').setVisibility(room.roomId, room.controllerCredential, {handles: ['zoe']});
    const fromOwner = await as('damien').mintInvite(room.roomId, room.controllerCredential, 'member', false);
    expect((await as('yann').redeemInvite(fromOwner.code, {displayName: 'yann', kind: 'human'})).role).toBe('member');
    const snapshot = await as('damien').snapshot(room.roomId, room.controllerCredential);
    expect(snapshot.visibility).toEqual({handles: ['zoe']});
});

test('test_a_room_made_without_a_personal_token_has_no_visibility_of_its_own', async () => {
    const plain = await new PairLobbyClient(relay.url).createRoom('plain', {displayName: 'someone', kind: 'human'}, undefined, undefined, 'public').catch((error: Error) => error);
    // This relay asks for a token to create rooms; a relay without one makes ownerless rooms everyone sees.
    expect(plain).toBeInstanceOf(Error);
    const open = await startServer({port: 0, dataFile: join(directory, 'open.sqlite')});
    try {
        const room = await new PairLobbyClient(open.url).createRoom('plain', {displayName: 'someone', kind: 'human'});
        await expect(new PairLobbyClient(open.url).setVisibility(room.roomId, room.controllerCredential, {handles: ['zoe']})).rejects.toThrow('made without a personal login');
        await expect(new PairLobbyClient(open.url).createRoom('scoped', {displayName: 'someone', kind: 'human'}, undefined, undefined, undefined, {handles: ['zoe']})).rejects.toThrow('made without a personal login');
    } finally {
        await open.close();
    }
});

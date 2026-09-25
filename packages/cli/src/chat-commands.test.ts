import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {newCredential, newId} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {isRoomCommand, runRoomCommand} from './chat-commands.js';
import type {RoomCommandContext} from './chat-commands.js';

type TestRoom = {owner: RoomCommandContext; code: string};
type TestMember = {context: RoomCommandContext; attempt: InviteAttempt};
type InviteAttempt = {attemptId: string; participantCredential: string};

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-moderation-'));
let server: RunningServer;
let client: PairLobbyClient;

beforeAll(async () => {
    server = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
    client = new PairLobbyClient(server.url);
});

afterAll(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

async function createRoom(): Promise<TestRoom> {
    const room = await client.createRoom('moderation', {displayName: 'owner', kind: 'human'});
    return {owner: {client, roomId: room.roomId, credential: room.participantCredential, controllerCredential: room.controllerCredential, participantId: room.participantId}, code: room.invite.code};
}

async function joinRoom(code: string, name = 'member'): Promise<TestMember> {
    const attempt = {attemptId: newId('attempt'), participantCredential: newCredential('participant')};
    const member = await client.redeemInvite(code, {displayName: name, kind: 'human'}, attempt);
    return {context: {client, roomId: member.roomId, credential: member.participantCredential, participantId: member.participantId}, attempt};
}

async function say(context: RoomCommandContext): Promise<unknown> {
    return client.send(context.roomId, context.credential, {type: 'message', payload: {text: '@owner hello', priority: 'normal'}, idempotencyKey: newId('event')});
}

function inviteCode(output: string): string {
    return output.split(' ')[1]!;
}

test('plain invite creates an observer that cannot write or run room commands', async () => {
    const {owner} = await createRoom();
    const code = inviteCode(await runRoomCommand('/invite', owner));
    const {context: guest} = await joinRoom(code, 'observer');
    const snapshot = await client.snapshot(guest.roomId, guest.credential);
    expect(snapshot.participants.find((participant) => participant.participantId === guest.participantId)?.role).toBe('guest');
    await expect(say(guest)).rejects.toMatchObject({code: 'unauthorized'});
    for (const command of ['/name someone', '/invite', '/invite as writer', '/lock', '/unlock', '/kick owner', '/mute owner', '/unmute owner']) {
        await expect(runRoomCommand(command, guest)).rejects.toMatchObject({code: 'unauthorized'});
    }
    await expect(client.mintInvite(guest.roomId, guest.credential)).rejects.toMatchObject({code: 'unauthorized'});
    await client.leave(guest.roomId, guest.credential);
});

test('members can rename themselves without controller credentials, and extra target fields are rejected', async () => {
    const {owner, code} = await createRoom();
    const {context: member} = await joinRoom(code);
    expect(isRoomCommand('/name New name')).toBe(true);
    await expect(runRoomCommand('/name New name', member)).resolves.toContain('default profile is unchanged');
    const snapshot = await client.snapshot(owner.roomId, owner.credential);
    expect(snapshot.participants.find((participant) => participant.participantId === member.participantId)).toMatchObject({displayName: 'New name', nameSource: 'room'});
    expect(snapshot.participants.find((participant) => participant.participantId === owner.participantId)?.displayName).toBe('owner');
    await expect(runRoomCommand('/name', member)).rejects.toThrow('Usage: /name');
    await expect(runRoomCommand('/name ALL', member)).rejects.toThrow('Usage: /name');
    const result = await fetch(`${server.url}/v1/rooms/${owner.roomId}/self/name`, {
        method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${member.credential}`},
        body: JSON.stringify({name: 'imposter', participantId: owner.participantId})
    });
    expect(result.status).toBe(400);
    await client.setMuted(owner.roomId, owner.controllerCredential!, member.participantId, true);
    await expect(runRoomCommand('/name Muted', member)).rejects.toMatchObject({code: 'participant_muted'});
});

test('named invite sets the default name and explicit overrides remain possible', async () => {
    const {owner} = await createRoom();
    const code = inviteCode(await runRoomCommand('/invite as Review Agent', owner));
    const {context: member} = await joinRoom(code, 'fallback');
    let snapshot = await client.snapshot(member.roomId, member.credential);
    expect(snapshot.participants.find((participant) => participant.participantId === member.participantId)?.displayName).toBe('Review Agent');
    await expect(say(member)).resolves.toBeDefined();
    await client.leave(member.roomId, member.credential);
    const overridden = await client.redeemInvite(code, {displayName: 'chosen', kind: 'human'}, undefined, false);
    snapshot = overridden.room;
    expect(snapshot.participants.find((participant) => participant.participantId === overridden.participantId)?.displayName).toBe('chosen');
    await expect(runRoomCommand('/invite as', owner)).rejects.toThrow('Usage:');
    await expect(runRoomCommand(`/invite as ${'x'.repeat(65)}`, owner)).rejects.toMatchObject({code: 'invalid_request'});
});

test('lock blocks all entry and invites but existing participants can talk; unlock restores entry', async () => {
    const {owner, code} = await createRoom();
    const {context: member, attempt} = await joinRoom(code);
    const unused = await client.mintInvite(owner.roomId, owner.credential);
    await client.setJoinPolicy(owner.roomId, owner.controllerCredential!, 'open_to_guests');
    await runRoomCommand('/lock', owner);
    expect((await client.snapshot(owner.roomId, owner.credential)).locked).toBe(true);
    await expect(say(member)).resolves.toBeDefined();
    await expect(joinRoom(unused.code)).rejects.toMatchObject({code: 'room_locked'});
    await expect(client.redeemInvite(code, {displayName: 'member', kind: 'human'}, attempt)).rejects.toMatchObject({code: 'room_locked'});
    await expect(client.joinAsGuest(owner.roomId, {displayName: 'guest', kind: 'human'})).rejects.toMatchObject({code: 'room_locked'});
    await expect(runRoomCommand('/invite', owner)).rejects.toMatchObject({code: 'room_locked'});
    await expect(client.mintInvite(owner.roomId, owner.controllerCredential!)).rejects.toMatchObject({code: 'room_locked'});
    await client.leave(member.roomId, member.credential);
    await expect(client.snapshot(member.roomId, member.credential)).rejects.toMatchObject({code: 'room_locked'});
    await expect(joinRoom(code)).rejects.toMatchObject({code: 'room_locked'});
    await runRoomCommand('/unlock', owner);
    await expect(joinRoom(code)).resolves.toBeDefined();
});

test('members cannot moderate or mint controller invitations through the API', async () => {
    const {owner, code} = await createRoom();
    const {context: member} = await joinRoom(code);
    for (const command of ['/lock', '/unlock', '/kick owner', '/mute owner', '/unmute owner']) {
        await expect(runRoomCommand(command, member)).rejects.toMatchObject({code: 'unauthorized'});
    }
    await expect(client.setLocked(owner.roomId, member.credential, true)).rejects.toMatchObject({code: 'unauthorized'});
    await expect(client.setMuted(owner.roomId, member.credential, owner.participantId, true)).rejects.toMatchObject({code: 'unauthorized'});
    await expect(client.revoke(owner.roomId, member.credential, owner.participantId)).rejects.toMatchObject({code: 'unauthorized'});
    await expect(client.mintInvite(owner.roomId, member.credential, 'controller')).rejects.toMatchObject({code: 'unauthorized'});
});

test('kick revokes access and prevents replaying the original attempt or reusing the seat', async () => {
    const {owner, code} = await createRoom();
    const {context: member, attempt} = await joinRoom(code);
    await runRoomCommand('/kick @member', owner);
    await expect(client.snapshot(member.roomId, member.credential)).rejects.toMatchObject({code: 'participant_revoked'});
    await expect(say(member)).rejects.toMatchObject({code: 'participant_revoked'});
    await expect(client.redeemInvite(code, {displayName: 'member', kind: 'human'}, attempt)).rejects.toMatchObject({code: 'participant_revoked'});
    await expect(joinRoom(code)).rejects.toMatchObject({code: 'invite_already_redeemed'});
    await expect(runRoomCommand('/kick owner', owner)).rejects.toThrow('Use /quit');
});

test('mute is enforced by the server, survives invite reuse, and can be reversed', async () => {
    const {owner, code} = await createRoom();
    const {context: member} = await joinRoom(code);
    await runRoomCommand('/mute member', owner);
    expect((await client.snapshot(member.roomId, member.credential)).participants.find((participant) => participant.participantId === member.participantId)?.muted).toBe(true);
    await expect(say(member)).rejects.toMatchObject({code: 'participant_muted'});
    await expect(client.mintInvite(member.roomId, member.credential)).rejects.toMatchObject({code: 'participant_muted'});
    await client.leave(member.roomId, member.credential);
    const {context: rejoined} = await joinRoom(code, 'renamed');
    await expect(say(rejoined)).rejects.toMatchObject({code: 'participant_muted'});
    await runRoomCommand('/unmute renamed', owner);
    await expect(say(rejoined)).resolves.toBeDefined();
});

test('moderation rejects ambiguous names and accepts participant IDs', async () => {
    const {owner, code} = await createRoom();
    const {context: first} = await joinRoom(code, 'same');
    const extra = await client.mintInvite(owner.roomId, owner.credential);
    await joinRoom(extra.code, 'same');
    await expect(runRoomCommand('/mute same', owner)).rejects.toThrow('Several participants');
    await expect(runRoomCommand(`/mute ${first.participantId}`, owner)).resolves.toContain('muted');
    await expect(runRoomCommand('/lock extra', owner)).rejects.toThrow('Usage:');
    await expect(runRoomCommand('/kick', owner)).rejects.toThrow('Usage:');
    expect(isRoomCommand('/invite as someone')).toBe(true);
    expect(isRoomCommand('/invited')).toBe(false);
});

test('a redeemed attempt cannot be replayed with another credential', async () => {
    const {code} = await createRoom();
    const {attempt} = await joinRoom(code);
    await expect(client.redeemInvite(code, {displayName: 'imposter', kind: 'human'}, {...attempt, participantCredential: newCredential('participant')})).rejects.toMatchObject({code: 'unauthorized'});
});

test('lock, mute, and named invites persist across a relay restart', async () => {
    const dataFile = join(directory, 'persistent.sqlite');
    let relay = await startServer({port: 0, dataFile});
    let connection = new PairLobbyClient(relay.url);
    try {
        const room = await connection.createRoom('persistent', {displayName: 'owner', kind: 'human'});
        const invited = await connection.mintInvite(room.roomId, room.participantCredential, 'member', true, undefined, 'remembered');
        const member = await connection.redeemInvite(room.invite.code, {displayName: 'member', kind: 'human'});
        await connection.setMuted(room.roomId, room.controllerCredential, member.participantId, true);
        await connection.setLocked(room.roomId, room.controllerCredential, true);
        await relay.close();
        relay = await startServer({port: 0, dataFile});
        connection = new PairLobbyClient(relay.url);
        const snapshot = await connection.snapshot(room.roomId, room.participantCredential);
        expect(snapshot.locked).toBe(true);
        expect(snapshot.participants.find((participant) => participant.participantId === member.participantId)?.muted).toBe(true);
        await expect(connection.redeemInvite(invited.code, {displayName: 'fallback', kind: 'human'})).rejects.toMatchObject({code: 'room_locked'});
        await connection.setLocked(room.roomId, room.controllerCredential, false);
        const joined = await connection.redeemInvite(invited.code, {displayName: 'fallback', kind: 'human'});
        expect(joined.room.participants.find((participant) => participant.participantId === joined.participantId)?.displayName).toBe('remembered');
    } finally {
        await relay.close();
    }
});

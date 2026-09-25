import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import type {CreatedRoom} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';
import {findRooms, formatFoundRooms} from './find.js';
import type {FindResult} from './find.js';

type RegisteredRoom = {created: CreatedRoom; sessionId: string};

const execute = promisify(execFile);
let directory: string;
let server: RunningServer;
let client: PairLobbyClient;
let store: LocalStore;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-find-'));
    server = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    client = new PairLobbyClient(server.url);
    store = new LocalStore(join(directory, 'client'));
});

afterEach(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

async function register(name = 'discovery'): Promise<RegisteredRoom> {
    const sessionId = newId('session');
    const created = await client.createRoom(name, {displayName: 'owner', kind: 'human', sessionId});
    store.upsertRoom({roomId: created.roomId, name, serverUrl: server.url, createdAt: created.room.createdAt, expiresAt: null, controls: true, sessions: []});
    store.addSession(created.roomId, {
        participantId: created.participantId, sessionId, displayName: 'owner', kind: 'human', role: 'member', joinedAt: created.room.createdAt, lastReadSeq: 0, cwd: directory
    });
    store.putCredential(created.roomId, sessionId, created.participantCredential);
    store.putCredential(created.roomId, 'controller', created.controllerCredential);
    return {created, sessionId};
}

async function cli(args: string[]): Promise<string> {
    const {stdout} = await execute(process.execPath, [resolve('packages/cli/dist/main.js'), 'find', ...args], {
        env: {...process.env, PAIRLOBBY_DATA_DIR: store.directory}, timeout: 10_000
    });
    return stdout;
}

test('find CLI reports fresh members and latest message without reading on behalf of a session', async () => {
    const {created, sessionId} = await register();
    const agent = await client.redeemInvite(created.invite.code, {displayName: 'helper', kind: 'agent'});
    const message = await client.send(created.roomId, agent.participantCredential, {
        type: 'message', recipientId: created.participantId, payload: {text: 'Ready to help', priority: 'normal'}, idempotencyKey: newId('event')
    });
    await client.rename(created.roomId, created.controllerCredential, 'renamed');
    const files = ['rooms.json', 'credentials.json'].map((file) => readFileSync(join(store.directory, file), 'utf8'));
    const output = await cli(['--json']);
    const result = JSON.parse(output) as FindResult;
    expect(result).toMatchObject({scope: 'device', count: 1, activeCount: 1});
    expect(result.rooms[0]).toMatchObject({
        name: 'renamed', createdAt: created.room.createdAt, reachable: true, active: true, participantCount: 2, presence: 'not_tracked',
        lastMessage: {eventId: message.event.eventId, senderId: agent.participantId, senderName: 'helper', text: 'Ready to help'}, lastMessageStatus: 'found'
    });
    expect(result.rooms[0]!.participants!.map((participant) => participant.displayName).sort()).toEqual(['helper', 'owner']);
    expect((await client.request(created.roomId, created.participantCredential, message.event.eventId)).receivedAt).toBeNull();
    expect(store.room(created.roomId)!.sessions.find((session) => session.sessionId === sessionId)!.lastReadSeq).toBe(0);
    expect(['rooms.json', 'credentials.json'].map((file) => readFileSync(join(store.directory, file), 'utf8'))).toEqual(files);
    expect(output).not.toContain(created.controllerCredential);
    expect(output).not.toContain(created.participantCredential);
    expect(await cli([])).toContain('Ready to help');
});

test('find searches past a full page of non-message events', async () => {
    const {created} = await register();
    await client.send(created.roomId, created.participantCredential, {type: 'message', payload: {text: 'Earlier message', priority: 'normal'}, idempotencyKey: newId('event')});
    for (let index = 0; index < 205; index++) {
        await client.rename(created.roomId, created.controllerCredential, `revision ${index}`);
    }
    expect((await findRooms(store)).rooms[0]!.lastMessage?.text).toBe('Earlier message');
});

test('find follows short server pages before choosing the latest message', async () => {
    const {created} = await register();
    for (let index = 0; index < 5; index++) {
        await client.send(created.roomId, created.participantCredential, {type: 'message', payload: {text: `message ${index}`, priority: 'normal'}, idempotencyKey: newId('event')});
    }
    const readEvents = PairLobbyClient.prototype.readEvents;
    const shortened = vi.spyOn(PairLobbyClient.prototype, 'readEvents').mockImplementation(function (this: PairLobbyClient, roomId: string, credential: string, after: number, limit = 200) {
        return readEvents.call(this, roomId, credential, after, Math.min(limit, 2));
    });
    try {
        expect((await findRooms(store)).rooms[0]!.lastMessage?.text).toBe('message 4');
        expect(shortened.mock.calls.length).toBeGreaterThan(1);
    } finally {
        shortened.mockRestore();
    }
});

test('departed and revoked members are excluded, and an empty room is not active', async () => {
    const {created} = await register();
    const member = await client.redeemInvite(created.invite.code, {displayName: 'gone', kind: 'agent'});
    await client.revoke(created.roomId, created.controllerCredential, member.participantId);
    await client.leave(created.roomId, created.participantCredential);
    const room = (await findRooms(store)).rooms[0]!;
    expect(room).toMatchObject({status: 'available', active: false, participantCount: 0, participants: [], lastMessage: null, lastMessageStatus: 'none_retained'});
    expect(JSON.parse(await cli(['--active', '--json']))).toMatchObject({count: 0, activeCount: 0, rooms: []});
});

test('stale session credentials fall back to another authorized credential', async () => {
    const {created, sessionId} = await register();
    store.putCredential(created.roomId, sessionId, 'invalid-credential');
    expect((await findRooms(store)).rooms[0]).toMatchObject({status: 'available', active: true});
    store.putCredential(created.roomId, 'controller', 'also-invalid');
    expect((await findRooms(store)).rooms[0]).toMatchObject({status: 'inaccessible', active: null, participants: null, error: 'unauthorized'});
});

test('closed, deleted and credential-less rooms do not appear active', async () => {
    const closed = await register('closed');
    const deleted = await register('deleted');
    await client.close(closed.created.roomId, closed.created.controllerCredential);
    await client.delete(deleted.created.roomId, deleted.created.controllerCredential);
    const missingId = newId('room');
    store.upsertRoom({roomId: missingId, name: 'no credentials', serverUrl: server.url, createdAt: Date.now(), expiresAt: null, controls: false, sessions: []});
    const result = await findRooms(store);
    expect(result.activeCount).toBe(0);
    expect(result.rooms.find((room) => room.roomId === closed.created.roomId)).toMatchObject({status: 'closed', active: false});
    expect(result.rooms.find((room) => room.roomId === deleted.created.roomId)).toMatchObject({status: 'deleted', active: false});
    expect(result.rooms.find((room) => room.roomId === missingId)).toMatchObject({status: 'inaccessible', active: null});
});

test('slow relays time out and do not hide healthy rooms; failed history remains unknown', async () => {
    const healthy = await register('healthy');
    const slow = await register('slow');
    let serveSnapshot = false;
    const hung = createServer((request, response) => {
        if (serveSnapshot && !request.url?.includes('/events')) {
            response.writeHead(200, {'content-type': 'application/json'});
            response.end(JSON.stringify(slow.created.room));
        }
    });
    await new Promise<void>((resolveReady) => hung.listen(0, '127.0.0.1', resolveReady));
    const address = hung.address();
    if (!address || typeof address === 'string') {
        throw new Error('missing test server port');
    }
    store.upsertRoom({...store.room(slow.created.roomId)!, serverUrl: `http://127.0.0.1:${address.port}`});
    try {
        const result = await findRooms(store, {timeoutMs: 200});
        expect(result.rooms.find((room) => room.roomId === healthy.created.roomId)?.active).toBe(true);
        expect(result.rooms.find((room) => room.roomId === slow.created.roomId)).toMatchObject({status: 'unreachable', active: null, error: 'timeout'});
        serveSnapshot = true;
        const partial = await findRooms(store, {rooms: [store.room(slow.created.roomId)!], timeoutMs: 200});
        expect(partial.rooms[0]).toMatchObject({reachable: true, active: true, lastMessageStatus: 'unavailable', error: 'timeout'});
    } finally {
        hung.closeAllConnections();
        await new Promise<void>((resolveClosed) => hung.close(() => resolveClosed()));
    }
});

test('CLI filters the device registry by room or server and handles no matches', async () => {
    const {created} = await register();
    expect(JSON.parse(await cli(['--room', created.roomId, '--local', '--json'])).count).toBe(1);
    expect(JSON.parse(await cli(['--server', server.url + '/', '--json'])).count).toBe(1);
    expect(JSON.parse(await cli(['--server', 'http://127.0.0.1:1', '--json'])).count).toBe(0);
    expect(await cli(['--server', 'http://127.0.0.1:1'])).toContain('No matching rooms');
    await expect(cli(['--local', '--server', server.url])).rejects.toThrow('use either --server or --local');
});

test('empty registry is a successful discovery and terminal messages cannot emit controls', async () => {
    expect(await findRooms(store)).toEqual({scope: 'device', count: 0, activeCount: 0, rooms: []});
    const {created} = await register();
    await client.send(created.roomId, created.participantCredential, {type: 'message', payload: {text: '\u001b[2Jhello\nworld', priority: 'normal'}, idempotencyKey: newId('event')});
    const text = formatFoundRooms(await findRooms(store));
    expect(text).not.toContain('\u001b');
    expect(text).toContain('hello world');
});

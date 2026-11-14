import {execFile} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {promisify} from 'node:util';
import {afterAll, beforeAll, expect, test, vi} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';
import type {ServerDescription} from '@pairlobby/protocol';
import {stageAnswerFile, stagedAnswerFileEntries, uploadAnswerFiles} from '../src/answer-files.js';
import {downloadPreview, parseFileRetention, saveFile, saveForAgent, splitAttachCommand} from '../src/files.js';

const execute = promisify(execFile);
const directory = mkdtempSync(join(tmpdir(), 'pairlobby-file-retention-'));
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

test('the CLI parses all lifetime choices and refuses invalid durations', () => {
    const folder = join(directory, 'parser');
    mkdirSync(folder);
    writeFileSync(join(folder, 'a.txt'), 'a');
    expect(parseFileRetention()).toBeUndefined();
    expect(parseFileRetention('forever')).toEqual({mode: 'forever'});
    expect(parseFileRetention('temporary')).toEqual({mode: 'temporary', ttlMs: 86400000});
    expect(parseFileRetention('2h')).toEqual({mode: 'temporary', ttlMs: 7200000});
    expect(splitAttachCommand('--file-retention until-received a.txt keep this', folder)).toEqual({paths: ['a.txt'], text: 'keep this', retention: {mode: 'until-received'}});
    for (const invalid of ['0s', '0.01s', '366d', 'whenever']) {
        expect(() => parseFileRetention(invalid)).toThrow();
    }
});

test('verified saves confirm receipt, previews do not, and agents reuse the local copy after relay deletion', async () => {
    const room = await client.createRoom('saved files', {displayName: 'owner', kind: 'human'});
    const agent = await client.redeemInvite(room.invite.code, {displayName: 'agent', kind: 'agent'});
    const human = await client.redeemInvite((await client.mintInvite(room.roomId, room.controllerCredential)).code, {displayName: 'reader', kind: 'human'});
    const bytes = new TextEncoder().encode('safe local copy');
    const file = await client.uploadFile(room.roomId, room.participantCredential, 'a.txt', bytes, 'text/plain', {mode: 'until-received'});
    const sent = await client.send(room.roomId, room.participantCredential, {type: 'message', payload: {text: 'file', priority: 'normal', attachments: [file]}, idempotencyKey: newId('event')});
    const humanContext = {client, roomId: room.roomId, credential: human.participantCredential};
    const agentContext = {client, roomId: room.roomId, credential: agent.participantCredential};
    expect(await downloadPreview(humanContext, file)).toContain('safe local copy');
    expect((await client.files(room.roomId, room.participantCredential))[0]!.receivedBy).toEqual([]);
    const workdir = join(directory, 'agent');
    const first = await saveForAgent(agentContext, [file], workdir, sent.event.eventId);
    const saved = await saveFile(humanContext, file, join(directory, 'human'));
    expect(readFileSync(saved, 'utf8')).toBe('safe local copy');
    expect((await client.fileList(room.roomId, room.participantCredential)).usage?.usedBytes).toBe(0);
    const download = vi.spyOn(client, 'downloadFileStream');
    try {
        expect(await saveForAgent(agentContext, [file], workdir, sent.event.eventId)).toEqual(first);
        expect(download).not.toHaveBeenCalled();
        writeFileSync(first[0]!.path, 'corrupted');
        await expect(saveForAgent(agentContext, [file], workdir, sent.event.eventId)).rejects.toThrow('no such file');
        expect(download).toHaveBeenCalledOnce();
    } finally {
        download.mockRestore();
    }
});

test('a corrupt response cannot acknowledge a file or leave partial output', async () => {
    const room = await client.createRoom('bad download', {displayName: 'owner', kind: 'human'});
    const joined = await client.redeemInvite(room.invite.code, {displayName: 'reader', kind: 'human'});
    const file = await client.uploadFile(room.roomId, room.participantCredential, 'a.txt', new TextEncoder().encode('hello'), 'text/plain', {mode: 'until-received'});
    await client.send(room.roomId, room.participantCredential, {type: 'message', payload: {text: 'file', priority: 'normal', attachments: [file]}, idempotencyKey: newId('event')});
    const original = globalThis.fetch;
    const mocked = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input).endsWith(`/files/${file.fileId}`) ? new Response('HELLO', {headers: {'content-length': '5', 'pairlobby-file-sha256': file.sha256}}) : original(input, init));
    const confirm = vi.spyOn(client, 'confirmFileReceipt');
    const folder = join(directory, 'corrupt');
    try {
        await expect(saveFile({client, roomId: room.roomId, credential: joined.participantCredential}, file, folder)).rejects.toThrow('damaged');
        expect(readdirSync(folder)).toEqual([]);
        expect(confirm).not.toHaveBeenCalled();
    } finally {
        mocked.mockRestore();
        confirm.mockRestore();
    }
    expect((await client.files(room.roomId, room.participantCredential))[0]!.receivedBy).toEqual([]);
});

test('an older relay is refused before any temporary file bytes are sent', async () => {
    const original = globalThis.fetch;
    let uploads = 0;
    const mocked = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input).endsWith('/v1/server')) {
            const description = await (await original(input, init)).json() as ServerDescription;
            return Response.json({...description, features: (description.features ?? []).filter((feature: string) => feature !== 'file-retention')});
        }
        uploads++;
        return original(input, init);
    });
    try {
        const old = new PairLobbyClient(server.url);
        await expect(old.uploadFile(newId('room'), 'unused', 'a.txt', new TextEncoder().encode('hello'), 'text/plain', {mode: 'temporary', ttlMs: 1000})).rejects.toMatchObject({code: 'unsupported_capability'});
        expect(uploads).toBe(0);
    } finally {
        mocked.mockRestore();
    }
});

test('send and reply accept retention flags and managed attachment tools persist their own choices', async () => {
    const room = await client.createRoom('shell retention', {displayName: 'owner', kind: 'human'});
    const other = await client.redeemInvite(room.invite.code, {displayName: 'reader', kind: 'human'});
    const device = join(directory, 'device');
    const workdir = join(directory, 'shell');
    mkdirSync(workdir);
    writeFileSync(join(workdir, 'file.txt'), 'hello');
    const store = new LocalStore(device);
    const sessionId = newId('session');
    store.upsertRoom({roomId: room.roomId, name: 'shell retention', serverUrl: server.url, createdAt: Date.now(), expiresAt: null, controls: true, sessions: []});
    store.addSession(room.roomId, {sessionId, participantId: room.participantId, displayName: 'owner', kind: 'human', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: workdir});
    store.putCredential(room.roomId, sessionId, room.participantCredential);
    const cli = async (...args: string[]) => execute(process.execPath, [process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js'), ...args, '--room', room.roomId, '--session', sessionId, '--json'], {cwd: workdir, env: {...process.env, PAIRLOBBY_DATA_DIR: device, PAIRLOBBY_PORT: '0', PAIRLOBBY_NO_UPDATE_CHECK: '1'}});
    await cli('send', '--file', 'file.txt', '--file-retention', '24h');
    expect((await client.files(room.roomId, room.participantCredential))[0]!.retention).toMatchObject({mode: 'temporary', expiresAt: expect.any(Number)});
    await expect(cli('send', 'text', '--file-retention', '24h')).rejects.toThrow('--file-retention requires --file');
    const request = await client.send(room.roomId, other.participantCredential, {type: 'message', recipientId: room.participantId, payload: {text: 'reply please', priority: 'normal'}, idempotencyKey: newId('event')});
    await client.acknowledgeMessage(room.roomId, room.participantCredential, request.event.eventId);
    await cli('reply', request.event.eventId, '--file', 'file.txt', '--file-retention', 'until-received');
    expect((await client.files(room.roomId, room.participantCredential)).some((file) => file.retention?.mode === 'until-received')).toBe(true);
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    try {
        stageAnswerFile(database, 'ev_test', workdir, 'file.txt', '2h');
        const staged = stagedAnswerFileEntries(database, 'ev_test');
        expect(staged[0]!.retention).toEqual({mode: 'temporary', ttlMs: 7200000});
        const uploaded = await uploadAnswerFiles({client, roomId: room.roomId, credential: room.participantCredential}, staged, workdir, true);
        expect(uploaded.problems).toEqual([]);
        expect(uploaded.attachments[0]!.retention).toMatchObject({mode: 'temporary'});
    } finally {
        database.close();
    }
});

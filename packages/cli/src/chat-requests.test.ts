import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';
import {runRequestsCommand} from './chat.js';

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-chat-requests-'));
});

afterEach(() => {
    rmSync(directory, {recursive: true, force: true});
});

test('interactive requests lists authorized recovery actions and runs dismiss and cancel', async () => {
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const room = await client.createRoom('chat recovery', {displayName: 'hugo', kind: 'human'});
    const agent = await client.redeemInvite(room.invite.code, {displayName: 'claude', kind: 'agent'});
    const store = new LocalStore(join(directory, 'device'));
    const sessionId = newId('session');
    store.upsertRoom({roomId: room.roomId, name: 'chat recovery', serverUrl: relay.url, createdAt: Date.now(), expiresAt: null, controls: true, sessions: []});
    store.addSession(room.roomId, {sessionId, participantId: room.participantId, displayName: 'hugo', kind: 'human', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory});
    const lines: string[] = [];
    const context = {client, roomId: room.roomId, credential: room.participantCredential, participantId: room.participantId, snapshot: await client.snapshot(room.roomId, room.participantCredential), store, controllerCredential: room.controllerCredential, emit: (line: string) => lines.push(line)};
    const ask = (text: string) => client.send(room.roomId, room.participantCredential, {type: 'message', recipientId: agent.participantId, payload: {text, priority: 'normal'}, idempotencyKey: newId('event')});
    try {
        const failed = await ask('failed work');
        await client.deliveryFailed(room.roomId, agent.participantCredential, failed.event.eventId, 'runtime failed', undefined, 'execution');
        await runRequestsCommand('', context);
        expect(lines.join('\n')).toContain(`/requests retry ${failed.event.eventId}`);
        expect(lines.join('\n')).toContain(`/requests dismiss ${failed.event.eventId}`);
        await runRequestsCommand(`dismiss ${failed.event.eventId} handled elsewhere`, context);
        expect(lines.at(-1)).toContain('dismissed; no success was recorded');
        expect((await client.request(room.roomId, room.participantCredential, failed.event.eventId)).resolution).toBe('dismissed');

        const pending = await ask('pending work');
        await runRequestsCommand(`cancel ${pending.event.eventId} superseded`, context);
        expect(lines.at(-1)).toContain('cancelled; no success was recorded');
        expect((await client.request(room.roomId, room.participantCredential, pending.event.eventId)).resolution).toBe('cancelled');
    } finally {
        client.closeLive();
        await relay.close();
    }
});

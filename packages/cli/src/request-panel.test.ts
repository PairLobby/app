import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';
import {ReceiverAttemptJournal, initializeReceiverDatabase} from './receiver-attempt-journal.js';
import {requestPage, requestsPage} from './request-panel.js';
import type {RequestPanelContext} from './request-panel.js';

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-request-panel-'));
});

afterEach(() => {
    rmSync(directory, {recursive: true, force: true});
});

test('request panel exposes details, local attempts, and confirmed recovery actions', async () => {
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const room = await client.createRoom('request panel', {displayName: 'hugo', kind: 'human'});
    const agent = await client.redeemInvite(room.invite.code, {displayName: 'codex', kind: 'agent'});
    const store = new LocalStore(join(directory, 'device'));
    const humanSession = newId('session');
    const agentSession = newId('session');
    store.upsertRoom({roomId: room.roomId, name: 'request panel', serverUrl: relay.url, createdAt: Date.now(), expiresAt: null, controls: true, sessions: []});
    store.addSession(room.roomId, {sessionId: humanSession, participantId: room.participantId, displayName: 'hugo', kind: 'human', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory});
    store.addSession(room.roomId, {sessionId: agentSession, participantId: agent.participantId, displayName: 'codex', kind: 'agent', runtime: 'codex', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: join(directory, 'workspace')});
    const context: RequestPanelContext = {client, roomId: room.roomId, credential: room.participantCredential, participantId: room.participantId, store, controllerCredential: room.controllerCredential};
    try {
        const sent = await client.send(room.roomId, room.participantCredential, {type: 'message', recipientId: agent.participantId, payload: {text: 'Finish the recovery implementation', priority: 'normal'}, idempotencyKey: newId('event')});
        await client.deliveryFailed(room.roomId, agent.participantCredential, sent.event.eventId, 'Runtime timed out', undefined, 'execution');

        const receiverDirectory = join(store.directory, 'receivers', agentSession);
        mkdirSync(receiverDirectory, {recursive: true});
        const database = new DatabaseSync(join(receiverDirectory, 'inbox.sqlite'));
        initializeReceiverDatabase(database);
        const journal = new ReceiverAttemptJournal(database);
        const attemptId = journal.start({requestEventId: sent.event.eventId, ordinal: 1, roomId: room.roomId, participantId: agent.participantId, sessionId: agentSession, ownerDeviceId: 'device', runtime: 'codex', workingDirectory: join(directory, 'workspace'), receiverProcessId: 123, startedAt: 1_000, idleTimeoutMs: 10_000, absoluteTimeoutMs: 60_000});
        journal.terminal(attemptId, {kind: 'idle_timeout', at: 2_000, failureReason: 'Runtime timed out'});
        database.close();

        const list = await requestsPage(context);
        expect(list.rows).toHaveLength(1);
        expect(list.rows[0]).toMatchObject({id: sent.event.eventId, section: 'Attention', action: {kind: 'menu'}});
        const details = await requestPage(context, sent.event.eventId);
        expect(new Set(details.rows.map((row) => row.id)).size).toBe(details.rows.length);
        expect(details.rows.find((row) => row.id === 'workspace')?.value).toBe(join(directory, 'workspace'));
        expect(details.rows.find((row) => row.id === 'attempt-history')?.value).toBe('1 recorded');
        expect(details.rows.filter((row) => row.section === 'Actions').map((row) => row.id)).toEqual(['retry', 'reassign', 'dismiss', 'cancel']);

        const dismiss = details.rows.find((row) => row.id === 'dismiss')?.action;
        expect(dismiss?.kind).toBe('edit');
        if (dismiss?.kind === 'edit') {
            await dismiss.save('Reviewed manually');
        }
        const resolved = await requestPage(context, sent.event.eventId);
        expect(resolved.rows.find((row) => row.id === 'resolution')?.value).toBe('dismissed · Reviewed manually');
        expect(resolved.rows.some((row) => row.section === 'Actions')).toBe(false);
        expect((await requestsPage(context)).rows[0]?.id).toBe('empty');
    } finally {
        client.closeLive();
        await relay.close();
    }
});

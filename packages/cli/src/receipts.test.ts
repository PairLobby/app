import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';
import type {ParticipantKind, ParticipantRole} from '@pairlobby/protocol';
import {ReceiptView} from './receipt-view.js';

type Reader = {participantId: string; participantCredential: string; sessionId: string};
const execute = promisify(execFile);

test('humans, Claude and Codex record independent receipts for agent messages, replies and broadcasts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-reader-receipts-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('receipts', {displayName: 'human', kind: 'human'});
    const store = new LocalStore(join(directory, 'device'));
    store.upsertRoom({roomId: host.roomId, name: 'receipts', serverUrl: relay.url, createdAt: host.room.createdAt, expiresAt: null, controls: false, sessions: []});
    function save(reader: Reader, name: string, kind: ParticipantKind, role: ParticipantRole = 'member'): Reader {
        store.addSession(host.roomId, {sessionId: reader.sessionId, participantId: reader.participantId, displayName: name, kind, role, joinedAt: host.room.createdAt, lastReadSeq: 0, cwd: directory});
        store.putCredential(host.roomId, reader.sessionId, reader.participantCredential);
        return reader;
    }
    async function read(reader: Reader): Promise<void> {
        await execute(process.execPath, [resolve('packages/cli/dist/main.js'), 'read', '--room', host.roomId, '--session', reader.sessionId, '--json'], {
            env: {...process.env, PAIRLOBBY_DATA_DIR: store.directory}, timeout: 10_000
        });
    }
    async function readers(eventId: string): Promise<string[]> {
        const events = (await client.readEvents(host.roomId, host.participantCredential, 0)).events;
        const view = new ReceiptView();
        for (const event of events) {
            view.observe(event);
        }
        return view.forMessage(eventId).map((receipt) => receipt.participantId).sort();
    }
    try {
        const human = save({...host, sessionId: newId('session')}, 'human', 'human');
        const claude = save({...await client.redeemInvite(host.invite.code, {displayName: 'Claude', kind: 'agent'}), sessionId: newId('session')}, 'Claude', 'agent');
        const invite = await client.mintInvite(host.roomId, host.participantCredential);
        const codex = save({...await client.redeemInvite(invite.code, {displayName: 'Codex', kind: 'agent'}), sessionId: newId('session')}, 'Codex', 'agent');
        const sent = await client.send(host.roomId, codex.participantCredential, {type: 'message', recipientId: claude.participantId, payload: {text: 'Hello Claude', priority: 'normal'}, idempotencyKey: newId('event')});
        await read(human);
        expect(await readers(sent.event.eventId)).toEqual([human.participantId]);
        expect((await client.request(host.roomId, codex.participantCredential, sent.event.eventId)).receivedAt).toBeNull();
        await read(claude);
        expect(await readers(sent.event.eventId)).toEqual([human.participantId, claude.participantId].sort());
        const reply = await client.reply(host.roomId, claude.participantCredential, sent.event.eventId, 'Hello Codex');
        await read(codex);
        await read(human);
        expect(await readers(reply.event.eventId)).toEqual([human.participantId, codex.participantId].sort());
        expect((await client.pendingRequests(host.roomId, codex.participantCredential, codex.participantId))).toHaveLength(0);
        const broadcast = await client.send(host.roomId, human.participantCredential, {type: 'message', payload: {text: 'Hello both', priority: 'normal'}, idempotencyKey: newId('event')});
        await read(claude);
        await read(codex);
        await read(claude);
        expect(await readers(broadcast.event.eventId)).toEqual([claude.participantId, codex.participantId].sort());
        const events = (await client.readEvents(host.roomId, human.participantCredential, 0)).events;
        expect(events.filter((event) => event.type === 'message.received' && event.payload.eventId === broadcast.event.eventId)).toHaveLength(2);
        const guestInvite = await client.mintInvite(host.roomId, human.participantCredential, 'guest');
        const guest = save({...await client.redeemInvite(guestInvite.code, {displayName: 'observer', kind: 'human'}), sessionId: newId('session')}, 'observer', 'human', 'guest');
        await read(guest);
        expect(await readers(broadcast.event.eventId)).not.toContain(guest.participantId);
        await client.setMuted(host.roomId, host.controllerCredential, claude.participantId, true);
        const mutedMessage = await client.send(host.roomId, human.participantCredential, {type: 'message', payload: {text: 'While muted', priority: 'normal'}, idempotencyKey: newId('event')});
        await read(claude);
        expect(await readers(mutedMessage.event.eventId)).toEqual([]);
    } finally {
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 15_000);

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {PairLobbyClient, RoomSubscription} from '@pairlobby/client';
import {newCredential, newId} from '@pairlobby/protocol';
import {MemoryStore} from '@pairlobby/fixtures';
import {RoomService} from '@pairlobby/server-core';
import {startServer} from '../src/server.js';

afterEach(() => vi.unstubAllGlobals());

test('retention invalidates a subscription cache and preserves cursor-gap behavior', async () => {
    const store = new MemoryStore();
    const service = new RoomService(store);
    const credential = newCredential('participant');
    const created = await service.createRoom({name: 'retained', displayName: 'owner', kind: 'human', participantCredential: credential, controllerCredential: newCredential('controller')});
    for (const text of ['old', 'kept']) {
        await service.send(created.roomId, credential, {type: 'message', payload: {text, priority: 'normal'}, idempotencyKey: newId('event')});
    }
    const client = new PairLobbyClient('https://relay.invalid');
    vi.spyOn(client, 'snapshot').mockImplementation(() => service.snapshot(created.roomId, credential));
    vi.spyOn(client, 'liveTransport').mockResolvedValue('poll');
    vi.spyOn(client, 'readEvents').mockImplementation((_room, _credential, after, limit = 200) => service.read(created.roomId, credential, after, limit));
    vi.spyOn(client, 'syncEvents').mockImplementation((_room, _credential, options) => service.read(created.roomId, credential, options.after, options.limit ?? 200, options.receiptsAfter, options));
    const live = new RoomSubscription(client, created.roomId, credential, {pollIntervalMs: 5});
    try {
        expect((await live.read(1)).events).toHaveLength(2);
        store.dropHistoryBefore(created.roomId, 3);
        const head = (await store.roomHead(created.roomId))!;
        await store.updateTurns(head.room, [], head.room.turnRevision ?? 0);
        await vi.waitFor(async () => expect((await live.snapshot()).earliestSeq).toBe(3));
        await expect(live.read(1)).rejects.toMatchObject({code: 'cursor_gap', details: {earliestAvailableSeq: 3}});
        expect((await live.read(2)).events.map((event) => event.seq)).toEqual([3]);
    } finally {
        await live.stop();
        vi.restoreAllMocks();
    }
});

test('one held read serves independent consumers without repeated idle snapshots or request queries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-subscription-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite'), receiptMode: 'watermark'});
    const owner = new PairLobbyClient(relay.url);
    const created = await owner.createRoom('sync', {displayName: 'owner', kind: 'human'});
    const agent = await owner.redeemInvite(created.invite.code, {displayName: 'agent', kind: 'agent'});
    const live = new RoomSubscription(new PairLobbyClient(relay.url), created.roomId, created.participantCredential);
    const fetcher = globalThis.fetch;
    const reads: string[] = [];
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!init?.method || init.method === 'GET') {
            reads.push(url.pathname + url.search);
        }
        return fetcher(input, init);
    }) as typeof fetch);
    try {
        const initial = await live.snapshot();
        await live.requests();
        await live.turns();
        await vi.waitFor(() => expect(reads.some((path) => path.includes('wait=25000'))).toBe(true));
        const baseline = reads.length;
        for (let index = 0; index < 4; index++) {
            await live.snapshot();
            await live.read(initial.latestSeq);
            await live.requests();
            await live.turns();
        }
        expect(reads).toHaveLength(baseline);
        const version = live.version;
        const sent = await owner.send(created.roomId, created.participantCredential, {type: 'message', recipientId: agent.participantId, payload: {text: 'read me', priority: 'normal'}, idempotencyKey: newId('event')});
        await live.wait(version, 2000);
        const first = await live.read(initial.latestSeq);
        const second = await live.read(initial.latestSeq);
        expect(first.events.map((event) => event.eventId)).toContain(sent.event.eventId);
        expect(second.events).toEqual(first.events);
        expect(await live.requests()).toHaveLength(1);
        const receiptVersion = live.version;
        await owner.postReceipt(created.roomId, agent.participantCredential, sent.event.seq);
        await live.wait(receiptVersion, 2000);
        expect((await live.requests())[0]?.receivedAt).not.toBeNull();
        expect((await live.snapshot()).latestSeq).toBe(sent.event.seq);
    } finally {
        await live.stop();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

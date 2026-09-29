import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test, vi} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {newId, ProtocolError} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';
import {startReceiptMonitor} from './receipt-monitor.js';
import type {ReceiptMonitor} from './receipt-monitor.js';

test('receipt monitor backfills pages, receives while paused/muted, retries, and resumes without duplicates', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-receipt-monitor-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const api = new PairLobbyClient(relay.url);
    const room = await api.createRoom('receipts', {displayName: 'owner', kind: 'human'});
    const agent = await api.redeemInvite(room.invite.code, {displayName: 'reader', kind: 'agent'});
    const options = {serverUrl: relay.url, roomId: room.roomId, participantId: agent.participantId, credential: agent.participantCredential, cursorPath: join(directory, 'cursor.json'), onError: (_message: string) => {}};
    let monitor: ReceiptMonitor | undefined;
    const receiptsFor = async (id: string) => (await api.readEvents(room.roomId, room.participantCredential, 0, 500)).events.filter((event) => event.type === 'message.received' && event.senderId === agent.participantId && event.payload.eventId === id);
    const send = (text: string) => api.send(room.roomId, room.participantCredential, {type: 'message', payload: {text, priority: 'normal'}, idempotencyKey: newId('event')});
    try {
        const own = await api.send(room.roomId, agent.participantCredential, {type: 'message', payload: {text: 'my message', priority: 'normal'}, idempotencyKey: newId('event')});
        const ids: string[] = [];
        for (let index = 0; index < 205; index++) {
            ids.push((await send(`notice ${index}`)).event.eventId);
        }
        await api.control(room.roomId, room.controllerCredential, agent.participantId, true);
        await api.setMuted(room.roomId, room.controllerCredential, agent.participantId, true);
        monitor = startReceiptMonitor(options);
        await vi.waitFor(async () => expect(await receiptsFor(ids.at(-1)!)).toHaveLength(1), {timeout: 8000});
        expect(await receiptsFor(ids[0]!)).toHaveLength(1);
        expect(await receiptsFor(own.event.eventId)).toHaveLength(0);
        expect(await api.pendingRequests(room.roomId, room.participantCredential)).toHaveLength(0);
        await monitor.stop();
        expect(existsSync(options.cursorPath)).toBe(true);
        const savedCursor = JSON.parse(readFileSync(options.cursorPath, 'utf8')).cursor;
        const later = await send('offline until restart');
        expect(await receiptsFor(later.event.eventId)).toHaveLength(0);

        let failed!: () => void;
        const failureObserved = new Promise<void>((resolve) => { failed = resolve; });
        const original = PairLobbyClient.prototype.acknowledgeMessage;
        let attempts = 0;
        vi.spyOn(PairLobbyClient.prototype, 'acknowledgeMessage').mockImplementation(async function (this: PairLobbyClient, roomId, credential, eventId) {
            if (eventId === later.event.eventId && attempts++ === 0) {
                throw new ProtocolError('server_unavailable', 'temporary receipt failure');
            }
            return original.call(this, roomId, credential, eventId);
        });
        monitor = startReceiptMonitor({...options, onError: (message) => { if (message) { failed(); } }});
        await failureObserved;
        expect(JSON.parse(readFileSync(options.cursorPath, 'utf8')).cursor).toBe(savedCursor);
        await vi.waitFor(async () => expect(await receiptsFor(later.event.eventId)).toHaveLength(1), {timeout: 5000});
        expect(attempts).toBeGreaterThan(1);
        const firstReceipt = (await receiptsFor(ids[0]!))[0]!;
        await monitor.stop();
        monitor = startReceiptMonitor(options);
        await vi.waitFor(async () => expect(await receiptsFor(later.event.eventId)).toHaveLength(1));
        expect((await receiptsFor(ids[0]!))[0]!.at).toBe(firstReceipt.at);
        expect((await api.turnQueue(room.roomId, room.participantCredential)).entries).toHaveLength(0);
    } finally {
        await monitor?.stop();
        vi.restoreAllMocks();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 20_000);

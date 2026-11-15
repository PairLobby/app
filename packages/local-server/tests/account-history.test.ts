import {newCredential, newId} from '@pairlobby/protocol';
import {RoomService, createRelay} from '@pairlobby/server-core';
import {expect, test} from 'vitest';

import {SqliteRoomStore} from '../src/sqlite-store.js';

test('trusted history reads paginate closed rooms without admission and retain the lifecycle boundary', async () => {
    const store = new SqliteRoomStore(':memory:');
    const clock = {now: 1_000_000};
    const service = new RoomService(store, () => clock.now);
    const controller = newCredential('controller');
    const participant = newCredential('participant');
    try {
        const room = await service.createRoom({name: 'Completed work', displayName: 'owner', kind: 'human', controllerCredential: controller, participantCredential: participant});
        await service.send(room.roomId, participant, {type: 'message', payload: {text: 'Verified conclusion', priority: 'normal'}, idempotencyKey: newId('event')});
        await service.close(room.roomId, controller);
        const before = store.changeCount();
        const first = await service.readAuthorizedHistory(room.roomId, 0, 1);
        expect(first.snapshot?.lifecycle).toBe('closed');
        expect(first.snapshot?.participants).toHaveLength(1);
        expect(first.events).toHaveLength(1);
        expect(first.hasMore).toBe(true);
        const rest = await service.readAuthorizedHistory(room.roomId, first.events[0]!.seq, 200);
        expect(rest.events.some((event) => event.type === 'message' && event.payload.text === 'Verified conclusion')).toBe(true);
        expect(rest.hasMore).toBe(false);
        expect(store.changeCount()).toBe(before);

        // The trusted method creates no anonymous or account-authenticated route on ordinary relays.
        const relay = createRelay({service});
        expect((await relay.handle(new Request(`https://relay.test/v1/rooms/${room.roomId}/events`))).status).toBe(401);
        expect((await relay.handle(new Request(`https://relay.test/v1/rooms/${room.roomId}/account-history`))).status).toBe(401);

        clock.now += first.snapshot!.policy.exportWindowMs + 1;
        await expect(service.readAuthorizedHistory(room.roomId, 0, 200)).rejects.toMatchObject({code: 'room_expired'});
    } finally {
        store.close();
    }
});

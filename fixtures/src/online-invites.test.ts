import {expect, test} from 'vitest';
import {RoomService} from '@pairlobby/server-core';
import {hashCredential, normalizeInviteCode} from '@pairlobby/protocol';
import {MemoryStore} from './memory-store.js';
test('online invite allocation retries a directory collision without publishing an ambiguous key', async () => {
    const seen: string[] = [];
    const store = new MemoryStore();
    const service = new RoomService(store, () => 1000, {
        reserve: async (code) => {
            seen.push(code);
            return seen.length > 1;
        }
    });
    const created = await service.createRoom({name: 'directory', displayName: 'host', kind: 'human', controllerCredential: 'c'.repeat(40), participantCredential: 'p'.repeat(40)});
    expect(seen).toHaveLength(2);
    expect(created.invite.code).toBe(seen[1]);
    expect(normalizeInviteCode(created.invite.code)).toHaveLength(12);
    expect(await store.inviteByDigest(await hashCredential(normalizeInviteCode(seen[0]!)!))).toBeNull();
    expect(await store.inviteByDigest(await hashCredential(normalizeInviteCode(seen[1]!)!))).not.toBeNull();
});

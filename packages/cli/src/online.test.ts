import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {LocalStore} from '@pairlobby/client';
import {accountToken, isOnlineKey, loginOnline, matchOnlineRoom, onlineRooms, resolveOnlineKey} from './online.js';
import type {OnlineRoom} from './online.js';
const directories: string[] = [];
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});
function store() {
    const path = mkdtempSync(join(tmpdir(), 'pairlobby-online-test-'));
    directories.push(path);
    return new LocalStore(path);
}
test('login validates before saving, stores credentials separately, and resolves a key without a room ID', async () => {
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', 'https://pairlobby.test');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', 'test-account-token');
    const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json({email: 'member@example.com'}))
        .mockResolvedValueOnce(Response.json({server: 'https://pairlobby.test/relay/workspace/team'}));
    vi.stubGlobal('fetch', fetcher);
    const local = store();
    expect(await loginOnline(local)).toBe('member@example.com');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', undefined);
    expect(accountToken(local)).toBe('test-account-token');
    expect(local.rooms()).toEqual([]);
    expect(await resolveOnlineKey(local, 'abcd-efgh-jkmn')).toBe('https://pairlobby.test/relay/workspace/team');
    expect(fetcher.mock.calls[1]![0]).toBe('https://pairlobby.test/api/online/invites/ABCDEFGHJKMN');
    expect(fetcher.mock.calls[1]![1].headers['x-pairlobby-account-token']).toBe('test-account-token');
    local.forgetRoom('online-account');
    expect(accountToken(local)).toBeUndefined();
});
test('rejected login never persists a token and a resolver cannot redirect credentials elsewhere', async () => {
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', 'https://pairlobby.test');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', 'bad-token');
    vi.stubGlobal(
        'fetch',
        vi
            .fn()
            .mockResolvedValueOnce(Response.json({error: {message: 'Login revoked'}}, {status: 401}))
            .mockResolvedValueOnce(Response.json({server: 'https://other.test/relay/room'}))
    );
    const local = store();
    await expect(loginOnline(local)).rejects.toThrow('Login revoked');
    expect(local.credential('online-account', 'https://pairlobby.test')).toBeUndefined();
    await expect(resolveOnlineKey(local, 'ABCD-EFGH-JKMN')).rejects.toThrow('invalid room address');
});

function onlineRoom(roomId: string, name: string): OnlineRoom {
    return {roomId, name, createdAt: 1, expiresAt: null, lifecycle: 'open', private: false, owner: true, participants: [], latestSeq: 0};
}

test('test_online_keys_are_told_apart_from_room_names', () => {
    expect(isOnlineKey('ABCD-EFGH-JKMN')).toBe(true);
    expect(isOnlineKey('abcd-efgh')).toBe(true);
    expect(isOnlineKey('my-project')).toBe(false);
    expect(isOnlineKey('ABCDEFGHJKMN')).toBe(false);
    expect(isOnlineKey('rm_14651R0FWDGDZSC86H8PM15NKM')).toBe(false);
});

test('test_account_rooms_match_by_id_or_unique_name', () => {
    const rooms = [onlineRoom('rm_A', 'Backend'), onlineRoom('rm_B', 'frontend'), onlineRoom('rm_C', 'frontend')];
    expect(matchOnlineRoom(rooms, 'backend').roomId).toBe('rm_A');
    expect(matchOnlineRoom(rooms, 'rm_C').roomId).toBe('rm_C');
    expect(() => matchOnlineRoom(rooms, 'frontend')).toThrow('rm_B, rm_C');
    expect(() => matchOnlineRoom(rooms, 'missing')).toThrow('pairlobby find online');
});

test('test_account_rooms_need_a_login_and_a_relay_on_the_online_origin', async () => {
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', 'https://pairlobby.test');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', undefined);
    const local = store();
    await expect(onlineRooms(local)).rejects.toThrow('pairlobby login');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', 'device-b-token');
    const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json({server: 'https://pairlobby.test/relay/workspace/team', rooms: [onlineRoom('rm_A', 'Backend')]}))
        .mockResolvedValueOnce(Response.json({server: 'https://other.test/relay/workspace/team', rooms: []}));
    vi.stubGlobal('fetch', fetcher);
    expect((await onlineRooms(local)).rooms.map((room) => room.roomId)).toEqual(['rm_A']);
    expect(fetcher.mock.calls[0]![0]).toBe('https://pairlobby.test/api/online/rooms');
    expect(fetcher.mock.calls[0]![1].headers['x-pairlobby-account-token']).toBe('device-b-token');
    await expect(onlineRooms(local)).rejects.toThrow('invalid room address');
});

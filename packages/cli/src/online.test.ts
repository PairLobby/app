import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {LocalStore} from '@pairlobby/client';
import {accountToken, loginOnline, resolveOnlineKey} from './online.js';
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

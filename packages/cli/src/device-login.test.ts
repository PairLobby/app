import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {LocalStore} from '@pairlobby/client';
import {DeviceLoginUnavailable, loginInBrowser} from './device-login.js';
import {accountToken, loginOnline, logoutOnline} from './online.js';

const ORIGIN = 'https://pairlobby.test';
const CODE = {deviceCode: 'device-secret', userCode: 'ABCD-EFGH', verificationUri: `${ORIGIN}/device`, verificationUriComplete: `${ORIGIN}/device?code=ABCD-EFGH`, expiresIn: 600, interval: 5};
const directories: string[] = [];

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

function store(): LocalStore {
    const path = mkdtempSync(join(tmpdir(), 'pairlobby-device-login-'));
    directories.push(path);
    return new LocalStore(path);
}

function pollError(code: string, status = 400): Response {
    return Response.json({error: {code, message: code}}, {status});
}

test('test_browser_login_polls_until_approved_and_backs_off_when_told', async () => {
    const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json(CODE, {status: 201}))
        .mockResolvedValueOnce(pollError('authorization_pending'))
        .mockResolvedValueOnce(pollError('slow_down'))
        .mockResolvedValueOnce(Response.json({token: 'pl_issued', email: 'alice@example.com'}));
    vi.stubGlobal('fetch', fetcher);
    const opened: string[] = [];
    const said: string[] = [];
    const waits: number[] = [];
    const token = await loginInBrowser({origin: ORIGIN, openBrowser: (url) => opened.push(url), say: (line) => said.push(line), wait: async (ms) => void waits.push(ms)});
    expect(token).toBe('pl_issued');
    expect(opened).toEqual([CODE.verificationUriComplete]);
    expect(said.join('\n')).toContain('ABCD-EFGH');
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toHaveProperty('deviceName');
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({deviceCode: 'device-secret'});
});

test('test_browser_login_reports_denial_and_expiry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(CODE, {status: 201})).mockResolvedValueOnce(pollError('access_denied')));
    await expect(loginInBrowser({origin: ORIGIN, openBrowser: false, say: () => {}, wait: async () => {}})).rejects.toThrow('denied in the browser');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(CODE, {status: 201})).mockResolvedValueOnce(pollError('expired_token')));
    await expect(loginInBrowser({origin: ORIGIN, openBrowser: false, say: () => {}, wait: async () => {}})).rejects.toThrow('expired');
});

test('test_browser_login_detects_a_service_without_it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({error: {message: 'Endpoint not found'}}, {status: 404})));
    await expect(loginInBrowser({origin: ORIGIN, openBrowser: false, say: () => {}, wait: async () => {}})).rejects.toBeInstanceOf(DeviceLoginUnavailable);
});

test('test_login_saves_the_approved_token_and_logout_revokes_it', async () => {
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', ORIGIN);
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', undefined);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
        callback();
        return 0;
    }) as unknown as typeof setTimeout);
    const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json(CODE, {status: 201}))
        .mockResolvedValueOnce(Response.json({token: 'pl_issued', email: 'alice@example.com'}))
        .mockResolvedValueOnce(Response.json({email: 'alice@example.com', userId: 'u1', server: `${ORIGIN}/relay/w/t`}))
        .mockResolvedValueOnce(Response.json({ok: true}));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const local = store();
    expect(await loginOnline(local, {openBrowser: false})).toBe('alice@example.com');
    expect(accountToken(local)).toBe('pl_issued');
    expect(await logoutOnline(local)).toEqual({removed: true, revoked: true});
    expect(fetcher.mock.calls[3]![0]).toBe(`${ORIGIN}/api/device/revoke`);
    expect(fetcher.mock.calls[3]![1].headers['x-pairlobby-account-token']).toBe('pl_issued');
    expect(accountToken(local)).toBeUndefined();
    expect(await logoutOnline(local)).toEqual({removed: false, revoked: null});
    vi.restoreAllMocks();
});

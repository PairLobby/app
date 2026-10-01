import {emitKeypressEvents} from 'node:readline';
import {LocalStore} from '@pairlobby/client';
import {normalizeInviteCode} from '@pairlobby/protocol';
import {UsageError} from './context.js';
import {DeviceLoginUnavailable, loginInBrowser, revokeToken} from './device-login.js';

type Keypress = {name?: string; ctrl?: boolean};

export function onlineOrigin(): string {
    const url = new URL(process.env['PAIRLOBBY_ONLINE_ORIGIN'] ?? 'https://pairlobby.com');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw new UsageError('Online service must use HTTPS');
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new UsageError('Online service must be an origin, without credentials or a path');
    }
    return url.origin;
}
export function accountToken(store: LocalStore, origin = onlineOrigin()) {
    return process.env['PAIRLOBBY_ACCOUNT_TOKEN'] ?? store.credential('online-account', origin);
}
async function request<T>(path: string, token?: string): Promise<T> {
    const response = await fetch(onlineOrigin() + path, {headers: token ? {'x-pairlobby-account-token': token} : {}, redirect: 'error', signal: AbortSignal.timeout(15000)});
    const data = (await response.json()) as {error?: {message?: string}};
    if (!response.ok) {
        throw new UsageError(data.error?.message ?? 'Online service unavailable');
    }
    return data as T;
}
export async function onlineAccount(store: LocalStore) {
    const result = await request<{email: string; userId: string; server: string}>('/api/online/account', accountToken(store));
    validateRelay(result.server);
    return result;
}
export type OnlineRoom = {
    roomId: string;
    name: string;
    createdAt: number;
    expiresAt: number | null;
    lifecycle: string;
    private: boolean;
    owner: boolean;
    participants: OnlineRoomParticipant[];
    latestSeq: number;
};

type OnlineRoomParticipant = {displayName: string; kind: string};

export type OnlineRooms = {server: string; rooms: OnlineRoom[]};

/** Rooms this account owns or is allowed into, from whichever device asks. */
export async function onlineRooms(store: LocalStore): Promise<OnlineRooms> {
    const token = accountToken(store);
    if (!token) {
        throw new UsageError('Run pairlobby login first to see your account rooms');
    }
    const result = await request<OnlineRooms>('/api/online/rooms', token);
    return {server: validateRelay(result.server), rooms: result.rooms};
}

/** An online key is dash-grouped, like ABCD-EFGH-JKMN; anything else names a room. */
export function isOnlineKey(value: string): boolean {
    return /^[0-9A-Za-z]{4}(-[0-9A-Za-z]{4}){1,2}$/.test(value) && normalizeInviteCode(value) !== null;
}

export function matchOnlineRoom(rooms: OnlineRoom[], reference: string): OnlineRoom {
    const byId = rooms.find((room) => room.roomId === reference);
    if (byId) {
        return byId;
    }
    const byName = rooms.filter((room) => room.name.toLowerCase() === reference.toLowerCase());
    if (byName.length === 1) {
        return byName[0]!;
    }
    if (byName.length > 1) {
        throw new UsageError(`"${reference}" matches several of your rooms: ${byName.map((room) => room.roomId).join(', ')}; pass the room id`);
    }
    throw new UsageError(`None of your account's rooms is called "${reference}"; run pairlobby find online to list them`);
}

export async function resolveOnlineKey(store: LocalStore, code: string): Promise<string> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) {
        throw new UsageError('Invalid online room key');
    }
    const result = await request<{server: string}>('/api/online/invites/' + normalized, accountToken(store));
    return validateRelay(result.server);
}
function validateRelay(value: string): string {
    const server = new URL(value);
    if (server.origin !== onlineOrigin() || !server.pathname.startsWith('/relay/') || server.username || server.password || server.search || server.hash) {
        throw new UsageError('The service returned an invalid room address');
    }
    return server.href;
}
export type LoginOptions = {
    /** Paste a token from the account page instead of approving in the browser. */
    paste?: boolean;
    /** False prints the approval address without opening a browser. */
    openBrowser?: boolean;
};

async function promptForToken(): Promise<string> {
    if (!process.stdin.isTTY) {
        throw new UsageError('Set PAIRLOBBY_ACCOUNT_TOKEN or run pairlobby login in a terminal');
    }
    process.stderr.write(`Create an account token at ${onlineOrigin()}/account.\nPaste account token (hidden): `);
    return new Promise<string>((resolve, reject) => {
        let value = '';
        const raw = process.stdin.isRaw;
        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        function finish(error?: Error) {
            process.stdin.off('keypress', press);
            process.stdin.setRawMode(raw);
            process.stdin.pause();
            process.stderr.write('\n');
            error ? reject(error) : resolve(value.trim());
        }
        function press(text: string, key: Keypress) {
            if (key.ctrl && key.name === 'c') {
                return finish(new UsageError('Login cancelled'));
            }
            if (key.name === 'return' || key.name === 'enter') {
                return finish();
            }
            if (key.name === 'backspace') {
                value = value.slice(0, -1);
            } else if (!key.ctrl && text) {
                value += text.replace(/[\x00-\x1f\x7f]/g, '');
            }
        }
        process.stdin.on('keypress', press);
    });
}

export async function loginOnline(store: LocalStore, options: LoginOptions = {}): Promise<string> {
    let token = process.env['PAIRLOBBY_ACCOUNT_TOKEN'];
    if (!token && options.paste) {
        token = await promptForToken();
    } else if (!token) {
        try {
            token = await loginInBrowser({origin: onlineOrigin(), openBrowser: options.openBrowser ?? process.stdin.isTTY === true});
        } catch (error) {
            if (!(error instanceof DeviceLoginUnavailable)) {
                throw error;
            }
            process.stderr.write('This service does not offer browser login yet; paste a token instead.\n');
            token = await promptForToken();
        }
    }
    if (!token) {
        throw new UsageError('Account token required');
    }
    const account = await request<{email: string}>('/api/online/account', token);
    store.putCredential('online-account', onlineOrigin(), token);
    return account.email;
}

export type LogoutResult = {removed: boolean; revoked: boolean | null};

/** Forgets the saved login and revokes it on the service; null means there was nothing saved to revoke. */
export async function logoutOnline(store: LocalStore): Promise<LogoutResult> {
    const origin = onlineOrigin();
    const saved = store.credential('online-account', origin);
    const revoked = saved ? await revokeToken(origin, saved) : null;
    store.forgetRoom('online-account');
    return {removed: saved !== undefined, revoked};
}

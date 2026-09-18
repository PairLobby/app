import {emitKeypressEvents} from 'node:readline';
import {LocalStore} from '@pairlobby/client';
import {normalizeInviteCode} from '@pairlobby/protocol';
import {UsageError} from './context.js';

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
export async function loginOnline(store: LocalStore): Promise<string> {
    let token = process.env['PAIRLOBBY_ACCOUNT_TOKEN'];
    if (!token) {
        if (!process.stdin.isTTY) {
            throw new UsageError('Set PAIRLOBBY_ACCOUNT_TOKEN or run pairlobby login in a terminal');
        }
        process.stderr.write(`Create an account token at ${onlineOrigin()}/account.\nPaste account token (hidden): `);
        token = await new Promise<string>((resolve, reject) => {
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
    if (!token) {
        throw new UsageError('Account token required');
    }
    const account = await request<{email: string}>('/api/online/account', token);
    store.putCredential('online-account', onlineOrigin(), token);
    return account.email;
}

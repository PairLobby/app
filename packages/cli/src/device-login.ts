//! Browser-approved login: the terminal shows a short code, the person approves it
//! on the website, and the terminal receives its own revocable account token.
//!
//! This follows the RFC 8628 device authorization pattern, so it also works from a
//! remote shell with no browser: open the printed address on any device.

import {spawn} from 'node:child_process';
import {hostname} from 'node:os';

import {UsageError} from './context.js';

export type DeviceCode = {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
};

export type DeviceLoginOptions = {
    origin: string;
    /** Opens the approval page; defaults to the system browser. False only prints the address. */
    openBrowser?: boolean | ((url: string) => void);
    /** Where instructions go; defaults to stderr so stdout stays clean for scripts. */
    say?: (line: string) => void;
    wait?: (ms: number) => Promise<void>;
};

type DeviceToken = {token: string; email: string | null};

type DeviceError = {error?: {code?: string; message?: string}};

/** Thrown when the service predates browser login, so the caller can offer token pasting instead. */
export class DeviceLoginUnavailable extends Error {}

async function post<T>(origin: string, path: string, payload: unknown): Promise<{ok: true; data: T} | {ok: false; status: number; code: string; message: string}> {
    let response: Response;
    try {
        response = await fetch(origin + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(15000)});
    } catch {
        throw new UsageError(`Could not reach ${origin}; check your connection and try again`);
    }
    const data = (await response.json().catch(() => ({}))) as T & DeviceError;
    if (response.ok) {
        return {ok: true, data};
    }
    return {ok: false, status: response.status, code: data.error?.code ?? 'server_unavailable', message: data.error?.message ?? 'Online service unavailable'};
}

export function openInBrowser(url: string): void {
    const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
    try {
        const child = spawn(command, args, {detached: true, stdio: 'ignore'});
        child.on('error', () => {});
        child.unref();
    } catch {
        // The printed address is enough; a missing opener is not a failure.
    }
}

export async function startDeviceLogin(origin: string, deviceName = hostname()): Promise<DeviceCode> {
    const started = await post<DeviceCode>(origin, '/api/device/code', {deviceName: deviceName.slice(0, 64) || 'Terminal'});
    if (!started.ok) {
        if (started.status === 404 || started.status === 405) {
            throw new DeviceLoginUnavailable('This service does not offer browser login yet');
        }
        throw new UsageError(started.message);
    }
    return started.data;
}

export async function loginInBrowser(options: DeviceLoginOptions): Promise<string> {
    const say = options.say ?? ((line: string) => process.stderr.write(`${line}\n`));
    const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const code = await startDeviceLogin(options.origin);
    say(`To log in, open ${code.verificationUriComplete}`);
    say(`and check that the page shows the code ${code.userCode}.`);
    if (options.openBrowser !== false) {
        (typeof options.openBrowser === 'function' ? options.openBrowser : openInBrowser)(code.verificationUriComplete);
    }
    say('Waiting for approval in the browser… (Ctrl+C to cancel)');

    let interval = Math.max(1, code.interval) * 1000;
    const deadline = Date.now() + code.expiresIn * 1000;
    while (Date.now() < deadline) {
        await wait(interval);
        const polled = await post<DeviceToken>(options.origin, '/api/device/token', {deviceCode: code.deviceCode});
        if (polled.ok) {
            return polled.data.token;
        }
        switch (polled.code) {
            case 'authorization_pending':
                break;
            case 'slow_down':
                interval += 5000;
                break;
            case 'access_denied':
                throw new UsageError('The login was denied in the browser');
            case 'expired_token':
                throw new UsageError('The login request expired; run pairlobby login again');
            default:
                throw new UsageError(polled.message);
        }
    }
    throw new UsageError('The login request expired; run pairlobby login again');
}

/** Revokes this terminal's token on the service. False means it could not be confirmed. */
export async function revokeToken(origin: string, token: string): Promise<boolean> {
    try {
        const response = await fetch(origin + '/api/device/revoke', {method: 'POST', headers: {'content-type': 'application/json', 'x-pairlobby-account-token': token}, body: '{}', redirect: 'error', signal: AbortSignal.timeout(15000)});
        return response.ok;
    } catch {
        return false;
    }
}

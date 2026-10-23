//! What a deployment says about itself at `/.well-known/pairlobby.json`: its name,
//! how people log in, and where its rooms live. Read with GET only, never following
//! a redirect, and every string it holds is made safe to print before it is used.

import type {LoginMode} from '@pairlobby/client';

import {UsageError} from './context.js';
import {NOT_A_DEPLOYMENT, displayText, normalizeOrigin} from './endpoints.js';

/** What a probe learned about a host. `tokenHelp` and `verify` come only from a discovery document. */
export type ProbeResult = {kind: 'discovery' | 'relay' | 'account'; name: string; loginMode: LoginMode; relayOrigins: string[]; tokenHelp?: string; verify?: string};

const PROBE_TIMEOUT_MS = 10_000;

/** The path a token is checked against when the document names none. */
export const DEFAULT_VERIFY = '/api/online/account';

export async function get(url: string): Promise<Response | null> {
    try {
        return await fetch(url, {method: 'GET', headers: {accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)});
    } catch {
        return null;
    }
}

export async function body(response: Response | null): Promise<Record<string, unknown> | null> {
    if (!response) {
        return null;
    }
    try {
        const value = await response.json() as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

const LOGIN_MODES: LoginMode[] = ['browser', 'token', 'none'];

/** A discovery document, or null when it is not one this CLI understands. A newer major version is refused outright; unknown fields are ignored. */
export function parseDiscovery(document: Record<string, unknown>, origin: string): ProbeResult | null {
    if (typeof document['version'] !== 'number') {
        return null;
    }
    if (document['version'] > 1) {
        throw new UsageError(`${origin} describes itself with a newer format (version ${document['version']}); update pairlobby and try again`, NOT_A_DEPLOYMENT);
    }
    const login = document['login'] as Record<string, unknown> | undefined;
    const mode = login && typeof login === 'object' ? login['mode'] : undefined;
    if (!LOGIN_MODES.includes(mode as LoginMode)) {
        return null;
    }
    const relays = Array.isArray(document['relays']) ? document['relays'] : [];
    if (!relays.every((relay) => typeof relay === 'string')) {
        return null;
    }
    const name = typeof document['name'] === 'string' ? displayText(document['name'], 64) : '';
    const help = typeof login!['tokenHelp'] === 'string' ? displayText(login!['tokenHelp'], 300) : '';
    // A same-origin path only: the token is never sent anywhere else.
    const verify = typeof login!['verify'] === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(login!['verify']) && !login!['verify'].startsWith('//') ? login!['verify'] : DEFAULT_VERIFY;
    return {
        kind: 'discovery',
        name: name || new URL(origin).host,
        loginMode: mode as LoginMode,
        relayOrigins: relays.length > 0 ? (relays as string[]).map((relay) => normalizeOrigin(relay, 'A relay the endpoint declares')) : [origin],
        ...(help ? {tokenHelp: help} : {}),
        verify,
    };
}

/** The discovery document at `origin`, or null when there is none this CLI understands. */
export async function readDiscovery(origin: string): Promise<ProbeResult | null> {
    const document = await body(await get(`${origin}/.well-known/pairlobby.json`));
    return document ? parseDiscovery(document, origin) : null;
}

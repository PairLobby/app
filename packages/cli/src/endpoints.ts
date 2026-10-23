//! Login endpoints: which service `login`, `create online`, `find online`,
//! `join online` and `invitations` talk to, and where their account token may go.
//!
//! pairlobby.com is built in. `pairlobby setup` saves others in settings.json and
//! picks the active one; tokens stay in credentials.json, one per origin. A token
//! is only ever sent to the origin it was issued for or to a relay that endpoint
//! declared when it was set up.

import type {LocalStore, LoginMode, SavedEndpoint} from '@pairlobby/client';

import {UsageError} from './context.js';

export const BUILT_IN_ORIGIN = 'https://pairlobby.com';
export const BUILT_IN_LABEL = 'pairlobby';

/** The endpoint in use. `hosted` keeps pairlobby.com's rules: rooms under `/relay/` on the same origin. */
export type Endpoint = SavedEndpoint & {label: string; hosted: boolean};

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Exit codes for `setup`: a host that is not PairLobby, and a refusal in an agent session. */
export const NOT_A_DEPLOYMENT = 3;
export const REFUSED = 4;

let override: string | undefined;

/** `--endpoint` on one command: a saved label or an address, used instead of the saved choice and never saved. */
export function useEndpointOverride(value: string | undefined): void {
    override = value;
}

/**
 * An origin from what a person typed: a bare host gains https, the host is
 * lowercased and a default port dropped. Only https, or http on this device.
 */
export function normalizeOrigin(value: string, what = 'Online service'): string {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new UsageError(`${what} needs an address`);
    }
    let url: URL;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
        throw new UsageError(`${what} is not a valid address: ${trimmed}`);
    }
    if (!url.hostname) {
        throw new UsageError(`${what} is not a valid address: ${trimmed}`);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) {
        throw new UsageError(`${what} must use HTTPS`);
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new UsageError(`${what} must be an origin, without credentials or a path`);
    }
    return url.origin;
}

export function builtInEndpoint(): Endpoint {
    return {label: BUILT_IN_LABEL, origin: BUILT_IN_ORIGIN, name: 'pairlobby.com', relayOrigins: [BUILT_IN_ORIGIN], loginMode: 'browser', savedAt: 0, hosted: true};
}

export function savedEndpoints(store: LocalStore): Record<string, SavedEndpoint> {
    return store.settings().endpoints ?? {};
}

function fromSaved(label: string, saved: SavedEndpoint): Endpoint {
    return {...saved, label, hosted: saved.origin === BUILT_IN_ORIGIN};
}

/** A saved endpoint, or pairlobby.com for its reserved label. */
export function endpointByLabel(store: LocalStore, label: string): Endpoint | undefined {
    if (label === BUILT_IN_LABEL) {
        return builtInEndpoint();
    }
    const saved = savedEndpoints(store)[label];
    return saved ? fromSaved(label, saved) : undefined;
}

/** An address not saved on this device behaves as pairlobby.com does, as PAIRLOBBY_ONLINE_ORIGIN always has. */
function adHoc(origin: string): Endpoint {
    return {label: origin, origin, name: new URL(origin).host, relayOrigins: [origin], loginMode: 'browser', savedAt: 0, hosted: true};
}

function byOrigin(store: LocalStore, origin: string): Endpoint {
    if (origin === BUILT_IN_ORIGIN) {
        return builtInEndpoint();
    }
    const found = Object.entries(savedEndpoints(store)).find(([, saved]) => saved.origin === origin);
    return found ? fromSaved(found[0], found[1]) : adHoc(origin);
}

/** The saved choice alone, ignoring the environment and `--endpoint`. */
export function savedActiveEndpoint(store: LocalStore): Endpoint {
    const label = store.settings().activeEndpoint;
    return (label ? endpointByLabel(store, label) : undefined) ?? builtInEndpoint();
}

/**
 * The endpoint for this command, highest first: PAIRLOBBY_ONLINE_ORIGIN,
 * `--endpoint`, the saved active endpoint, pairlobby.com.
 */
export function activeEndpoint(store: LocalStore): Endpoint {
    const environment = process.env['PAIRLOBBY_ONLINE_ORIGIN'];
    if (environment) {
        return byOrigin(store, normalizeOrigin(environment));
    }
    if (override) {
        return endpointByLabel(store, override) ?? byOrigin(store, normalizeOrigin(override, '--endpoint'));
    }
    return savedActiveEndpoint(store);
}

/**
 * Whether this endpoint's token may go to a relay: its own origin or one it declared.
 * A pairlobby.com-shaped endpoint keeps its rooms under `/relay/`, so only those paths get it.
 */
export function tokenMayGo(endpoint: Endpoint, value: string): boolean {
    try {
        const server = new URL(value);
        if (endpoint.hosted) {
            return server.origin === endpoint.origin && server.pathname.startsWith('/relay/');
        }
        return server.origin === endpoint.origin || endpoint.relayOrigins.includes(server.origin);
    } catch {
        return false;
    }
}

/** Whether a room address belongs to this endpoint: its own origin or one it declared, and for pairlobby.com a `/relay/` path. */
export function relayBelongs(endpoint: Endpoint, value: string): boolean {
    let server: URL;
    try {
        server = new URL(value);
    } catch {
        return false;
    }
    if (server.protocol !== 'https:' && !(server.protocol === 'http:' && LOOPBACK.includes(server.hostname))) {
        return false;
    }
    if (server.username || server.password || server.search || server.hash) {
        return false;
    }
    if (endpoint.hosted) {
        return server.origin === endpoint.origin && server.pathname.startsWith('/relay/');
    }
    return server.origin === endpoint.origin || endpoint.relayOrigins.includes(server.origin);
}

/**
 * The relay `create` and `join <code>` use when nothing else names one: the active
 * endpoint's, when it is not pairlobby.com and has exactly one. Several are never guessed.
 */
export function endpointRelay(store: LocalStore): string | undefined {
    const endpoint = activeEndpoint(store);
    if (endpoint.hosted) {
        return undefined;
    }
    const relays = [...new Set(endpoint.relayOrigins.length > 0 ? endpoint.relayOrigins : [endpoint.origin])];
    return relays.length === 1 ? relays[0] : undefined;
}

/** Labels: lowercase letters, digits and `-`, 2 to 32 characters, never the reserved one. */
export function validateLabel(label: string): string {
    if (!/^[a-z0-9-]{2,32}$/.test(label)) {
        throw new UsageError('An endpoint name is 2 to 32 lowercase letters, digits or -');
    }
    if (label === BUILT_IN_LABEL) {
        throw new UsageError(`"${BUILT_IN_LABEL}" is reserved for pairlobby.com`);
    }
    return label;
}

/** The first usable label of the host: `team.example.com` gives `team`; a reserved or unusable one moves to the next. */
export function defaultLabel(origin: string): string {
    const labels = new URL(origin).hostname.split('.').map((part) => part.toLowerCase().replace(/[^a-z0-9-]/g, ''));
    return labels.find((part) => /^[a-z0-9-]{2,32}$/.test(part) && part !== BUILT_IN_LABEL) ?? 'endpoint';
}

export type EndpointInput = {label: string; origin: string; name: string; relayOrigins: string[]; loginMode: LoginMode};

/** Saves an endpoint and makes it active. Saving the same origin again updates it under its label. */
export function saveEndpoint(store: LocalStore, input: EndpointInput, now = Date.now()): Endpoint {
    const endpoints = {...savedEndpoints(store)};
    const taken = endpoints[input.label];
    if (taken && taken.origin !== input.origin) {
        throw new UsageError(`"${input.label}" already names ${taken.origin}; pick another with --name`);
    }
    for (const [label, saved] of Object.entries(endpoints)) {
        if (saved.origin === input.origin && label !== input.label) {
            delete endpoints[label];
        }
    }
    endpoints[input.label] = {origin: input.origin, name: input.name, relayOrigins: input.relayOrigins, loginMode: input.loginMode, savedAt: now};
    store.setSettings({endpoints, activeEndpoint: input.label});
    return fromSaved(input.label, endpoints[input.label]!);
}

export function useEndpoint(store: LocalStore, label: string): Endpoint {
    const endpoint = endpointByLabel(store, label);
    if (!endpoint) {
        throw new UsageError(`No endpoint called "${label}" on this device; pairlobby setup --show lists them`);
    }
    if (label === BUILT_IN_LABEL) {
        resetEndpoint(store);
    } else {
        store.setSettings({activeEndpoint: label});
    }
    return endpoint;
}

/** Forgets a saved endpoint and its token, without asking the service to revoke it. */
export function removeEndpoint(store: LocalStore, label: string): Endpoint {
    if (label === BUILT_IN_LABEL) {
        throw new UsageError('pairlobby.com is built in and cannot be removed');
    }
    const endpoints = {...savedEndpoints(store)};
    const saved = endpoints[label];
    if (!saved) {
        throw new UsageError(`No endpoint called "${label}" on this device; pairlobby setup --show lists them`);
    }
    delete endpoints[label];
    const active = store.settings().activeEndpoint;
    store.setSettings({endpoints, ...(active === label ? {activeEndpoint: undefined} : {})});
    store.forgetCredential('online-account', saved.origin);
    return fromSaved(label, saved);
}

/** pairlobby.com is active again; other endpoints and their tokens stay saved. */
export function resetEndpoint(store: LocalStore): void {
    store.setSettings({activeEndpoint: undefined});
}

/** Text from an endpoint, safe to print: no control characters or escape sequences, bounded length. */
export function displayText(value: string, limit: number): string {
    const plain = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
    return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}

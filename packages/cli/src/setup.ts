//! `pairlobby setup`: choose the login endpoint this device uses.
//!
//! Saving an endpoint decides where account tokens go, so it is for a person at a
//! terminal: the address is shown exactly as it will be used and confirmed before
//! anything is saved, the probe sends GET requests only, and agent sessions are
//! refused everything but `--show`.

import {createInterface} from 'node:readline/promises';

import type {LocalStore, LoginMode} from '@pairlobby/client';

import {UsageError} from './context.js';
import {BUILT_IN_LABEL, NOT_A_DEPLOYMENT, REFUSED, activeEndpoint, builtInEndpoint, defaultLabel, endpointByLabel, normalizeOrigin, removeEndpoint, resetEndpoint, saveEndpoint, savedActiveEndpoint, savedEndpoints, useEndpoint, validateLabel} from './endpoints.js';
import type {Endpoint} from './endpoints.js';
import type {ProbeResult} from './discovery.js';
import {body, get, parseDiscovery} from './discovery.js';
import {accountToken} from './online.js';
import {json, out} from './render.js';

export type SetupOptions = {
    url?: string | undefined;
    name?: string | undefined;
    relays: string[];
    yes: boolean;
    login: boolean;
    json: boolean;
    show: boolean;
    use?: string | undefined;
    remove?: string | undefined;
    reset: boolean;
};

export type SetupDeps = {
    /** A person is at a terminal that can answer a prompt. */
    interactive: boolean;
    /** This command runs inside an agent's session. */
    agent: boolean;
    ask: (question: string) => Promise<string>;
    login: (store: LocalStore) => Promise<string | null>;
};

export const AGENT_REFUSAL = 'Changing the login endpoint is for a person at a terminal, not an agent session.';

/**
 * What answers at `origin`, from GET requests only, stopping at the first match: its
 * discovery document, a relay's `/v1/server`, or an account service's 401. Nothing is
 * written to a host the person has not approved.
 */
export async function probeEndpoint(origin: string): Promise<ProbeResult> {
    const discovery = await body(await get(`${origin}/.well-known/pairlobby.json`));
    const described = discovery ? parseDiscovery(discovery, origin) : null;
    if (described) {
        return described;
    }
    const server = await get(`${origin}/v1/server`);
    const info = server?.ok ? await body(server) : null;
    if (info && ('protocol' in info || 'shareUrls' in info || 'version' in info)) {
        return {kind: 'relay', name: new URL(origin).host, loginMode: 'none', relayOrigins: [origin]};
    }
    const account = await get(`${origin}/api/online/account`);
    const refusal = account?.status === 401 ? await body(account) : null;
    const error = refusal?.['error'] as Record<string, unknown> | undefined;
    if (error && typeof error === 'object' && typeof error['code'] === 'string' && typeof error['message'] === 'string') {
        return {kind: 'account', name: new URL(origin).host, loginMode: 'browser', relayOrigins: [origin]};
    }
    throw new UsageError(`${origin} does not look like a PairLobby deployment`, NOT_A_DEPLOYMENT);
}

type EndpointSummary = {label: string; origin: string; name: string; loginMode: LoginMode; relayOrigins: string[]; active: boolean; tokenSaved: boolean};

function summary(store: LocalStore, endpoint: Endpoint, active: Endpoint): EndpointSummary {
    return {label: endpoint.label, origin: endpoint.origin, name: endpoint.name, loginMode: endpoint.loginMode, relayOrigins: endpoint.relayOrigins, active: endpoint.label === active.label, tokenSaved: store.credential('online-account', endpoint.origin) !== undefined};
}

function allEndpoints(store: LocalStore): Endpoint[] {
    return [builtInEndpoint(), ...Object.keys(savedEndpoints(store)).map((label) => endpointByLabel(store, label)!)];
}

function showEndpoints(store: LocalStore, asJson: boolean): number {
    const active = activeEndpoint(store);
    const endpoints = allEndpoints(store).map((endpoint) => summary(store, endpoint, active));
    if (asJson) {
        json({active: summary(store, active, active), endpoints});
        return 0;
    }
    out(`Endpoint        ${active.origin}`);
    out(`Name            ${active.name}${active.label === BUILT_IN_LABEL || active.label === active.origin ? '' : ` (${active.label})`}`);
    out(`Login           ${active.loginMode}`);
    out(`Rooms live on   ${active.relayOrigins.join(', ')}`);
    out(`Token saved     ${store.credential('online-account', active.origin) !== undefined ? 'yes' : 'no'}`);
    if (process.env['PAIRLOBBY_ONLINE_ORIGIN']) {
        out('(chosen by PAIRLOBBY_ONLINE_ORIGIN for this shell)');
    }
    if (endpoints.length > 1) {
        out('');
        out('Saved on this device:');
        for (const endpoint of endpoints) {
            out(`  ${endpoint.active ? '*' : ' '} ${endpoint.label.padEnd(12)} ${endpoint.origin}`);
        }
        out('');
        out('Switch with: pairlobby setup --use <name>');
    }
    return 0;
}

function refuseAgent(deps: SetupDeps): void {
    if (deps.agent) {
        throw new UsageError(AGENT_REFUSAL, REFUSED);
    }
}

async function addEndpoint(store: LocalStore, options: SetupOptions, deps: SetupDeps): Promise<number> {
    const origin = normalizeOrigin(options.url!, 'The endpoint');
    const extra = options.relays.map((relay) => normalizeOrigin(relay, '--relay'));
    const label = options.name !== undefined ? validateLabel(options.name) : defaultLabel(origin);
    if (!options.yes && !deps.interactive) {
        throw new UsageError('pairlobby setup asks for confirmation; run it in a terminal, or pass --yes after checking the address');
    }
    const found = await probeEndpoint(origin);
    const relayOrigins = [...new Set([...found.relayOrigins, ...extra])];
    if (!options.json || !options.yes) {
        out(`Endpoint        ${origin}`);
        out(`Name            ${found.kind === 'discovery' ? found.name : '(none)'}`);
        out(`Login           ${found.loginMode}`);
        out(`Rooms live on   ${relayOrigins.join(', ')}`);
        out('');
    }
    if (!options.yes) {
        const answer = (await deps.ask('Use this endpoint for login, online rooms and invitations on this device? [y/N] ')).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
            out('Nothing saved.');
            return 1;
        }
    }
    const saved = saveEndpoint(store, {label, origin, name: found.name, relayOrigins, loginMode: found.loginMode});
    if (options.json && !options.login) {
        json(summary(store, saved, saved));
        return 0;
    }
    out(saved.loginMode === 'none' ? `Saved as "${label}". ${saved.name} has no login; create and join rooms there with no --server.` : `Saved as "${label}". Run pairlobby login to sign in to ${saved.name}.`);
    if (options.login && saved.loginMode !== 'none') {
        const email = await deps.login(store);
        out(email ? `Logged in as ${email}` : `Logged in to ${saved.name}`);
    }
    return 0;
}

/** The interactive form of `setup` with no arguments: switch, add or remove. */
async function setupMenu(store: LocalStore, options: SetupOptions, deps: SetupDeps): Promise<number> {
    showEndpoints(store, false);
    const endpoints = allEndpoints(store);
    out('');
    endpoints.forEach((endpoint, index) => out(`  ${index + 1}) use ${endpoint.label} (${endpoint.origin})`));
    out('  a) add an endpoint');
    if (endpoints.length > 1) {
        out('  r) remove an endpoint');
    }
    const choice = (await deps.ask('Choose (Enter to leave things as they are): ')).trim().toLowerCase();
    if (!choice) {
        return 0;
    }
    if (choice === 'a') {
        const url = (await deps.ask('Address of the deployment: ')).trim();
        return url ? addEndpoint(store, {...options, url}, deps) : 0;
    }
    if (choice === 'r' && endpoints.length > 1) {
        const label = (await deps.ask('Name to remove: ')).trim();
        return label ? setupCommand(store, {...options, remove: label}, deps) : 0;
    }
    const picked = endpoints[Number(choice) - 1];
    if (!picked) {
        throw new UsageError(`"${choice}" is not one of the choices`);
    }
    return setupCommand(store, {...options, use: picked.label}, deps);
}

export async function setupCommand(store: LocalStore, options: SetupOptions, deps: SetupDeps = DEFAULT_SETUP): Promise<number> {
    const nothing = !options.url && !options.use && !options.remove && !options.reset;
    if (options.show || (nothing && !deps.interactive)) {
        return showEndpoints(store, options.json);
    }
    refuseAgent(deps);
    if ([options.url, options.use, options.remove, options.reset || undefined].filter(Boolean).length > 1) {
        throw new UsageError('Pick one of: setup <url>, --use, --remove, --reset');
    }
    if (options.use) {
        const endpoint = useEndpoint(store, options.use);
        out(`Using ${endpoint.name} (${endpoint.origin})${accountToken(store, endpoint) ? '' : '. Run pairlobby login to sign in.'}`);
        return 0;
    }
    if (options.remove) {
        const removed = removeEndpoint(store, options.remove);
        out(`Removed ${removed.label} (${removed.origin}) and its saved login. ${savedActiveEndpoint(store).name} is the active endpoint.`);
        return 0;
    }
    if (options.reset) {
        resetEndpoint(store);
        out('Using pairlobby.com. Other saved endpoints and their logins are kept.');
        return 0;
    }
    if (options.url) {
        return addEndpoint(store, options, deps);
    }
    return setupMenu(store, options, deps);
}

async function ask(question: string): Promise<string> {
    const reader = createInterface({input: process.stdin, output: process.stderr});
    try {
        return await reader.question(question);
    } finally {
        reader.close();
    }
}

export const DEFAULT_SETUP: SetupDeps = {
    interactive: process.stdin.isTTY === true,
    agent: false,
    ask,
    login: async (store) => (await import('./online.js')).loginOnline(store),
};

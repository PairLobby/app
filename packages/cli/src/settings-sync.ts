//! Keeps this device's preferences in step with the logged-in account. Each setting
//! syncs on its own and the most recent change wins; see `ACCOUNT_SETTING_SCHEMAS`.

import type {LocalStore, Profile, Settings} from '@pairlobby/client';
import {ACCOUNT_SETTING_DEFINITIONS, ACCOUNT_SETTING_DEFAULTS, ACCOUNT_SETTING_FIELDS, parseAccountSettingsDocument} from '@pairlobby/protocol';
import type {AccountSettingChange, AccountSettingField, AccountSettingValues, AccountSettingsDocument} from '@pairlobby/protocol';

import {UsageError} from './errors.js';
import {activeEndpoint} from './endpoints.js';
import type {Endpoint} from './endpoints.js';
import {accountToken} from './online.js';
import {formatDuration} from './when.js';

export const SETTINGS_PATH = '/api/online/settings';
export const LAUNCH_SYNC_TIMEOUT_MS = 2000;
export const CHANGE_SYNC_TIMEOUT_MS = 5000;

export type SyncSource = 'account' | 'device';
export type SyncOutcome = {applied: AccountSettingField[]; sent: AccountSettingField[]};
export type SettingDifference = {field: AccountSettingField; label: string; device: string; account: string};
export type SyncStatus = {endpoint: string; loggedIn: boolean; enabled: boolean; pending: AccountSettingField[]};

type SyncTarget = {endpoint: Endpoint; token: string};
type SyncRequest = {target: SyncTarget; timeoutMs: number; changes?: AccountSettingChange[]};

/** The service has no settings API: an older deployment, or a self-hosted relay without accounts. */
export class SettingsSyncUnavailable extends Error {}

function target(store: LocalStore): SyncTarget | undefined {
    const endpoint = activeEndpoint(store);
    const token = endpoint.loginMode === 'browser' ? accountToken(store, endpoint) : undefined;
    return token ? {endpoint, token} : undefined;
}

async function call({target: {endpoint, token}, timeoutMs, changes}: SyncRequest): Promise<AccountSettingsDocument> {
    const response = await fetch(endpoint.origin + SETTINGS_PATH, {method: changes ? 'PUT' : 'GET', headers: {'x-pairlobby-account-token': token, ...(changes ? {'content-type': 'application/json'} : {})}, ...(changes ? {body: JSON.stringify({changes})} : {}), redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
    if (response.status === 404 || response.status === 405) {
        throw new SettingsSyncUnavailable(`${endpoint.name} does not keep settings for accounts yet`);
    }
    const data = (await response.json().catch(() => ({}))) as {error?: {message?: string}};
    if (!response.ok) {
        throw new UsageError(data.error?.message ?? `${endpoint.name} could not sync settings (${response.status})`);
    }
    return parseAccountSettingsDocument(data);
}

export function syncEnabled(store: LocalStore): boolean {
    const found = target(store);
    return found !== undefined && store.settingsSync().accounts[found.endpoint.origin]?.enabled === true;
}

/** Settings changed on this device that the account has not confirmed. The account refuses one that is older than its own and sends its value back. */
export function pendingSettings(store: LocalStore, origin = activeEndpoint(store).origin): AccountSettingField[] {
    const state = store.settingsSync();
    const held = state.accounts[origin]?.held ?? {};
    return ACCOUNT_SETTING_FIELDS.filter((field) => state.changedAt[field] !== undefined && state.changedAt[field] !== held[field]);
}

export function syncStatus(store: LocalStore): SyncStatus {
    const endpoint = activeEndpoint(store);
    return {endpoint: endpoint.name, loggedIn: target(store) !== undefined, enabled: syncEnabled(store), pending: syncEnabled(store) ? pendingSettings(store) : []};
}

function applySettings(store: LocalStore, values: Partial<AccountSettingValues>): void {
    const {displayName, ...rest} = values;
    if (Object.keys(rest).length > 0) {
        store.setSettings(rest as Partial<Settings>);
    }
    if (displayName !== undefined) {
        store.setProfile({displayName: displayName ?? undefined} as Profile);
    }
}

/**
 * Newest wins, setting by setting: the account's value replaces this device's when the account's change is
 * at least as recent, and this device's changes the account has not seen are returned to send. A tie goes
 * to the account, so two devices always settle on the same value.
 */
function reconcile(store: LocalStore, origin: string, document: AccountSettingsDocument): AccountSettingChange[] {
    const state = store.settingsSync();
    const local = store.accountSettingValues();
    const held = {...state.accounts[origin]?.held};
    const adopt: Partial<Record<AccountSettingField, unknown>> = {};
    const changedAt = {...state.changedAt};
    const send: AccountSettingChange[] = [];
    for (const field of ACCOUNT_SETTING_FIELDS) {
        const remote = document.settings[field];
        const mine = state.changedAt[field];
        if (remote && (mine === undefined || remote.updatedAt >= mine)) {
            if (remote.value !== local[field]) {
                adopt[field] = remote.value;
            }
            changedAt[field] = remote.updatedAt;
            held[field] = remote.updatedAt;
        } else if (mine !== undefined && mine !== held[field]) {
            send.push({field, value: local[field], updatedAt: mine});
        }
    }
    applySettings(store, adopt as Partial<AccountSettingValues>);
    const after = store.settingsSync();
    store.setSettingsSync({...after, changedAt: {...after.changedAt, ...changedAt}, clockOffsetMs: document.serverTime - Date.now(), accounts: {...after.accounts, [origin]: {enabled: after.accounts[origin]?.enabled ?? false, held}}});
    return send;
}

/** Fetches the account's settings, takes the newer ones and sends this device's newer ones. Null when sync is off or nobody is logged in. */
export async function syncSettings(store: LocalStore, timeoutMs = LAUNCH_SYNC_TIMEOUT_MS): Promise<SyncOutcome | null> {
    const found = target(store);
    if (!found || !syncEnabled(store)) {
        return null;
    }
    const before = store.accountSettingValues();
    const send = reconcile(store, found.endpoint.origin, await call({target: found, timeoutMs}));
    if (send.length > 0) {
        reconcile(store, found.endpoint.origin, await call({target: found, timeoutMs, changes: send}));
    }
    const after = store.accountSettingValues();
    return {applied: ACCOUNT_SETTING_FIELDS.filter((field) => before[field] !== after[field]), sent: send.map((change) => change.field)};
}

/** Sends what changed on this device right away; the account's answer may also bring newer values for other settings. */
export async function pushSettings(store: LocalStore, timeoutMs = CHANGE_SYNC_TIMEOUT_MS): Promise<SyncOutcome | null> {
    const found = target(store);
    if (!found || !syncEnabled(store)) {
        return null;
    }
    const pending = pendingSettings(store, found.endpoint.origin);
    if (pending.length === 0) {
        return {applied: [], sent: []};
    }
    const local = store.accountSettingValues();
    const changedAt = store.settingsSync().changedAt;
    const changes = pending.map((field) => ({field, value: local[field], updatedAt: changedAt[field]!}));
    reconcile(store, found.endpoint.origin, await call({target: found, timeoutMs, changes}));
    const after = store.accountSettingValues();
    return {applied: ACCOUNT_SETTING_FIELDS.filter((field) => local[field] !== after[field]), sent: pending};
}

/** The note printed after a local change; a failed send is kept and retried at the next sync. */
export async function pushSettingsNote(store: LocalStore): Promise<string | undefined> {
    try {
        const outcome = await pushSettings(store);
        return outcome && outcome.sent.length > 0 ? `synced with your ${activeEndpoint(store).name} account` : undefined;
    } catch (error) {
        return `saved on this device; your account gets it at the next sync (${error instanceof Error ? error.message : String(error)})`;
    }
}

function describe(field: AccountSettingField, value: unknown): string {
    const definition = ACCOUNT_SETTING_DEFINITIONS.find((candidate) => candidate.field === field)!;
    if (typeof value === 'boolean') {
        return value ? 'on' : 'off';
    }
    if (value === null) {
        return definition.kind === 'name' ? 'not set' : 'never';
    }
    if (typeof value === 'number') {
        return formatDuration(value);
    }
    return definition.choices?.find((choice) => choice.value === value)?.label ?? String(value);
}

/** Where this device and the account disagree; a setting the account never saved counts as its default. */
export function settingDifferences(store: LocalStore, document: AccountSettingsDocument): SettingDifference[] {
    const local = store.accountSettingValues();
    return ACCOUNT_SETTING_DEFINITIONS.flatMap(({field, label}) => {
        const account = document.settings[field] ? document.settings[field]!.value : ACCOUNT_SETTING_DEFAULTS[field];
        return account === local[field] ? [] : [{field, label, device: describe(field, local[field]), account: describe(field, account)}];
    });
}

export async function fetchAccountSettings(store: LocalStore, timeoutMs = CHANGE_SYNC_TIMEOUT_MS): Promise<AccountSettingsDocument> {
    const found = target(store);
    if (!found) {
        throw new UsageError('Log in first: pairlobby login');
    }
    return call({target: found, timeoutMs});
}

/**
 * Turns sync on. `account` takes every setting the account holds; `device` makes this device's values
 * the newest everywhere. Either way the account ends up holding every synced setting.
 */
export async function enableSync(store: LocalStore, source: SyncSource, document?: AccountSettingsDocument): Promise<SyncOutcome> {
    const found = target(store);
    if (!found) {
        throw new UsageError('Log in first: pairlobby login');
    }
    const origin = found.endpoint.origin;
    const current = document ?? await call({target: found, timeoutMs: CHANGE_SYNC_TIMEOUT_MS});
    const state = store.settingsSync();
    const newest = Math.max(store.syncNow(), current.serverTime, ...Object.values(current.settings).map((entry) => entry!.updatedAt + 1));
    const changedAt = {...state.changedAt};
    for (const field of ACCOUNT_SETTING_FIELDS) {
        if (source === 'device' || !current.settings[field]) {
            changedAt[field] = newest;
        } else {
            delete changedAt[field];
        }
    }
    store.setSettingsSync({...state, changedAt, accounts: {...state.accounts, [origin]: {enabled: true, held: {}}}});
    const before = store.accountSettingValues();
    const send = reconcile(store, origin, current);
    if (send.length > 0) {
        reconcile(store, origin, await call({target: found, timeoutMs: CHANGE_SYNC_TIMEOUT_MS, changes: send}));
    }
    const after = store.accountSettingValues();
    return {applied: ACCOUNT_SETTING_FIELDS.filter((field) => before[field] !== after[field]), sent: send.map((change) => change.field)};
}

/** Stops syncing with the active endpoint's account; this device keeps its current values. */
export function disableSync(store: LocalStore, origin = activeEndpoint(store).origin): boolean {
    const state = store.settingsSync();
    if (!state.accounts[origin]) {
        return false;
    }
    const {[origin]: _removed, ...accounts} = state.accounts;
    store.setSettingsSync({...state, accounts});
    return true;
}

export function syncedLabels(fields: AccountSettingField[]): string {
    return fields.map((field) => ACCOUNT_SETTING_DEFINITIONS.find((definition) => definition.field === field)!.label).join(', ');
}

export type SyncPromptDeps = {ask: (question: string) => Promise<string>; say: (line: string) => void};

/**
 * Asked right after `pairlobby login` in a terminal. When this device and the account disagree it shows the
 * differences and lets the person keep either side; otherwise it is a plain yes or no.
 */
export async function offerSettingsSync(store: LocalStore, deps: SyncPromptDeps): Promise<SyncOutcome | null> {
    let document: AccountSettingsDocument;
    try {
        document = await fetchAccountSettings(store);
    } catch (error) {
        if (!(error instanceof SettingsSyncUnavailable)) {
            deps.say(`Settings sync skipped: ${error instanceof Error ? error.message : String(error)}. Run pairlobby settings sync on to try again.`);
        }
        return null;
    }
    const differences = settingDifferences(store, document);
    const empty = Object.keys(document.settings).length === 0;
    if (differences.length === 0 || empty) {
        const question = empty ? `Sync this device's settings with your account, so your other devices and ${activeEndpoint(store).origin}/settings share them? [Y/n] ` : 'Keep this device\'s settings in sync with your account? [Y/n] ';
        const answer = (await deps.ask(question)).trim().toLowerCase();
        if (answer !== '' && !/^y(es)?$/.test(answer)) {
            deps.say('Settings sync is off. Turn it on later with pairlobby settings sync on.');
            return null;
        }
        return enableSync(store, 'device', document);
    }
    deps.say('Your account has its own settings. Where they differ:');
    for (const difference of differences) {
        deps.say(`  ${difference.label}: this device ${difference.device}, account ${difference.account}`);
    }
    const answer = (await deps.ask('Sync with your account? [a] use the account\'s settings, [d] keep this device\'s and send them, [n] don\'t sync: ')).trim().toLowerCase();
    if (answer === 'a' || answer === 'account') {
        return enableSync(store, 'account', document);
    }
    if (answer === 'd' || answer === 'device') {
        return enableSync(store, 'device', document);
    }
    deps.say('Settings sync is off. Turn it on later with pairlobby settings sync on.');
    return null;
}

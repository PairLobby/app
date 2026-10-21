//! `pairlobby serve` settings from flags and the environment. A container or a service
//! manager configures the relay through PAIRLOBBY_* variables; a flag wins over its variable.

import {readFileSync, statSync} from 'node:fs';

import type {AdmissionLimits} from '@pairlobby/server-core';
import type {RequestLogMode} from '@pairlobby/local-server';

import {UsageError} from './context.js';

export type RelayFlags = {host?: string; port?: string; publicUrl?: string; trustedProxyHeader?: string; requestLog?: string; backup?: string; noRestore?: boolean};

export type RelayEnvironment = Record<string, string | undefined>;

export type RelaySettings = {
    host?: string;
    port?: number;
    publicUrl?: string;
    trustedProxyHeader?: string;
    createToken?: string;
    /** Exact Host values to accept beyond the relay's own, such as an internal DNS name. */
    allowedHosts: string[];
    limits: Partial<AdmissionLimits>;
    requestLog?: RequestLogMode;
    backup?: RelayBackupSettings;
};

/** Where and how often to copy the database; `url` is checked against the relay's own parser when the relay starts. */
export type RelayBackupSettings = {url: string; intervalMs: number; keep: number; restore: boolean};

type Source = {flag?: string; variable: string};

const LIMIT_VARIABLES: Record<keyof AdmissionLimits, string> = {
    createPerMinutePerAddress: 'PAIRLOBBY_LIMIT_CREATE_PER_MIN_IP',
    redeemPerMinutePerAddress: 'PAIRLOBBY_LIMIT_REDEEM_PER_MIN_IP',
    redeemPerMinuteGlobal: 'PAIRLOBBY_LIMIT_REDEEM_PER_MIN_GLOBAL'
};

/** Every variable `serve` reads, for help text and documentation. */
export const RELAY_VARIABLES = ['PAIRLOBBY_HOST', 'PAIRLOBBY_PORT', 'PAIRLOBBY_DATA_DIR', 'PAIRLOBBY_PUBLIC_URL', 'PAIRLOBBY_TRUSTED_PROXY_HEADER', 'PAIRLOBBY_ALLOWED_HOSTS', 'PAIRLOBBY_CREATE_TOKEN', 'PAIRLOBBY_CREATE_TOKEN_FILE', 'PAIRLOBBY_REQUEST_LOG', 'PAIRLOBBY_BACKUP', 'PAIRLOBBY_BACKUP_INTERVAL', 'PAIRLOBBY_BACKUP_KEEP', 'PAIRLOBBY_BACKUP_S3_ENDPOINT', 'PAIRLOBBY_NO_RESTORE', ...Object.values(LIMIT_VARIABLES)];

function described({flag, variable}: Source): string {
    return flag ? `--${flag} (${variable})` : variable;
}

/** A flag, else its variable; an empty variable counts as unset. */
function pick(flag: string | undefined, environment: RelayEnvironment, variable: string): string | undefined {
    return flag ?? (environment[variable]?.trim() || undefined);
}

export function parsePublicUrl(value: string, source: Source = {flag: 'public-url', variable: 'PAIRLOBBY_PUBLIC_URL'}): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new UsageError(`${described(source)} must be a full address such as https://laptop.tailnet.ts.net, not "${value}"`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new UsageError(`${described(source)} must be an http(s) origin with no path, credentials, query or fragment`);
    }
    return url.origin;
}

function wholeNumber(value: string, source: Source, minimum: number, maximum: number): number {
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || parsed < minimum || parsed > maximum) {
        throw new UsageError(`${described(source)} must be a whole number from ${minimum} to ${maximum}, not "${value}"`);
    }
    return parsed;
}

/** The token from the variable, or from a file only its owner can read; never both, never from a flag. */
function createToken(environment: RelayEnvironment): string | undefined {
    const inline = environment['PAIRLOBBY_CREATE_TOKEN'] || undefined;
    const file = environment['PAIRLOBBY_CREATE_TOKEN_FILE']?.trim() || undefined;
    if (inline && file) {
        throw new UsageError('set PAIRLOBBY_CREATE_TOKEN or PAIRLOBBY_CREATE_TOKEN_FILE, not both');
    }
    if (!file) {
        return inline;
    }
    let mode: number;
    try {
        mode = statSync(file).mode;
    } catch {
        throw new UsageError(`PAIRLOBBY_CREATE_TOKEN_FILE names ${file}, which cannot be read`);
    }
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
        throw new UsageError(`${file} must be readable only by its owner: chmod 600 ${file}`);
    }
    const token = readFileSync(file, 'utf8').trim();
    if (!token) {
        throw new UsageError(`${file} is empty; put the create token in it`);
    }
    return token;
}

export function relaySettings(flags: RelayFlags, environment: RelayEnvironment): RelaySettings {
    const host = pick(flags.host, environment, 'PAIRLOBBY_HOST');
    const port = pick(flags.port, environment, 'PAIRLOBBY_PORT');
    const publicUrl = pick(flags.publicUrl, environment, 'PAIRLOBBY_PUBLIC_URL');
    const proxyHeader = pick(flags.trustedProxyHeader, environment, 'PAIRLOBBY_TRUSTED_PROXY_HEADER')?.trim().toLowerCase();
    if (proxyHeader !== undefined && !/^[a-z0-9-]+$/.test(proxyHeader)) {
        throw new UsageError(`${described({flag: 'trusted-proxy-header', variable: 'PAIRLOBBY_TRUSTED_PROXY_HEADER'})} must be a header name such as x-forwarded-for`);
    }
    const allowedHosts = (environment['PAIRLOBBY_ALLOWED_HOSTS'] ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    for (const value of allowedHosts) {
        if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(value)) {
            throw new UsageError(`PAIRLOBBY_ALLOWED_HOSTS takes Host values such as relay.internal or relay.internal:8790, not "${value}"`);
        }
    }
    const limits: Partial<AdmissionLimits> = {};
    for (const [key, variable] of Object.entries(LIMIT_VARIABLES) as [keyof AdmissionLimits, string][]) {
        const value = environment[variable]?.trim();
        if (value) {
            limits[key] = wholeNumber(value, {variable}, 1, 1_000_000);
        }
    }
    const requestLog = pick(flags.requestLog, environment, 'PAIRLOBBY_REQUEST_LOG');
    if (requestLog !== undefined && !['all', 'writes', 'off'].includes(requestLog)) {
        throw new UsageError(`${described({flag: 'request-log', variable: 'PAIRLOBBY_REQUEST_LOG'})} must be all, writes or off, not "${requestLog}"`);
    }
    const token = createToken(environment);
    const backup = backupSettings(flags, environment);
    return {
        ...(host ? {host} : {}),
        // 0 lets the system choose a free port.
        ...(port ? {port: wholeNumber(port, {flag: 'port', variable: 'PAIRLOBBY_PORT'}, 0, 65_535)} : {}),
        ...(publicUrl ? {publicUrl: parsePublicUrl(publicUrl)} : {}),
        ...(proxyHeader ? {trustedProxyHeader: proxyHeader} : {}),
        ...(token ? {createToken: token} : {}),
        allowedHosts,
        limits,
        ...(requestLog && requestLog !== 'off' ? {requestLog: requestLog as RequestLogMode} : {}),
        ...(backup ? {backup} : {})
    };
}

function backupSettings(flags: RelayFlags, environment: RelayEnvironment): RelayBackupSettings | undefined {
    const url = pick(flags.backup, environment, 'PAIRLOBBY_BACKUP');
    const interval = environment['PAIRLOBBY_BACKUP_INTERVAL']?.trim();
    const keep = environment['PAIRLOBBY_BACKUP_KEEP']?.trim();
    const endpoint = environment['PAIRLOBBY_BACKUP_S3_ENDPOINT']?.trim();
    const noRestore = environment['PAIRLOBBY_NO_RESTORE']?.trim().toLowerCase();
    if (noRestore && !['1', 'true', '0', 'false'].includes(noRestore)) {
        throw new UsageError(`PAIRLOBBY_NO_RESTORE must be 1 or 0, not "${noRestore}"`);
    }
    if (endpoint && !/^https?:\/\/[^/]+\/?$/.test(endpoint)) {
        throw new UsageError(`PAIRLOBBY_BACKUP_S3_ENDPOINT must be an http(s) origin such as https://<account>.r2.cloudflarestorage.com, not "${endpoint}"`);
    }
    if (!url) {
        if (interval || keep || endpoint || flags.noRestore) {
            throw new UsageError('backup settings need a place to back up to: set --backup (PAIRLOBBY_BACKUP) to s3://bucket/prefix or a folder');
        }
        return undefined;
    }
    return {
        url,
        intervalMs: interval ? wholeNumber(interval, {variable: 'PAIRLOBBY_BACKUP_INTERVAL'}, 10, 86_400) * 1000 : 60_000,
        keep: keep ? wholeNumber(keep, {variable: 'PAIRLOBBY_BACKUP_KEEP'}, 1, 10_000) : 48,
        restore: !(flags.noRestore || noRestore === '1' || noRestore === 'true')
    };
}

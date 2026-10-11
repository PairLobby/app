import {createHash} from 'node:crypto';
import {accessSync, constants, mkdirSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, dirname, isAbsolute, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export type ProviderLimitKind = 'session' | 'weekly' | 'unknown';
export type ProviderLimitSource = 'result' | 'result_errors' | 'stderr';
export type ParsedResetTime = {retryAt: number; timezone: string};

export type ProviderUsageLimit = {
    provider: 'claude';
    model?: string;
    limitKind: ProviderLimitKind;
    detectedAt: number;
    retryAt: number | null;
    resetTimezone: string | null;
    displayMessage: string;
    resetActionUrl: 'https://clau.de/reset' | null;
    automaticRetry: boolean;
    source: ProviderLimitSource;
};

export type ProviderRetryTarget = {
    roomId: string;
    participantId: string;
    requestId: string;
};

export type ProviderCooldown = ProviderUsageLimit & {
    repeatedWithoutLaterReset: number;
    wakeAt: number | null;
    probeOwner?: string;
    probePid?: number;
    probeExpiresAt?: number;
    manualTarget?: ProviderRetryTarget;
};

export type CooldownClaimInput = {
    profileKey: string;
    owner: string;
    pid: number;
    now: number;
    leaseMs: number;
    roomId: string;
    participantId: string;
};

export type ClaudeLimitEvidence = {
    result?: string;
    errors?: string[];
    stderr?: string;
    now?: number;
    defaultTimezone?: string;
};

export class ProviderUsageLimited extends Error {
    constructor(readonly limit: ProviderUsageLimit) {
        super(limit.displayMessage);
        this.name = 'ProviderUsageLimited';
    }
}

const STRONG_LIMIT = /(?:usage limit reached|you(?:'|’)ve hit your (?:session|weekly|usage) limit|session limit(?: reached)?|weekly limit(?: reached)?)/i;
const TIME = /(?:resets?|continuing automatically)\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)/i;
const TIMEZONE = /\b([A-Z][A-Za-z_+-]+\/[A-Z][A-Za-z0-9_+.-]+(?:\/[A-Z][A-Za-z0-9_+.-]+)?)\b/;
const RESET_URL = /https:\/\/clau\.de\/reset\b/i;

function partsAt(timestamp: number, timezone: string): Record<string, number> {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(timestamp));
    return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function localTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
    let candidate = desired;
    for (let attempt = 0; attempt < 3; attempt++) {
        const shown = partsAt(candidate, timezone);
        const represented = Date.UTC(shown['year']!, shown['month']! - 1, shown['day']!, shown['hour']!, shown['minute']!, shown['second']!);
        candidate += desired - represented;
    }
    return candidate;
}

export function parseResetTime(text: string, now: number, defaultTimezone?: string): ParsedResetTime | null {
    const match = TIME.exec(text);
    const timezone = TIMEZONE.exec(text)?.[1] ?? defaultTimezone;
    if (!match || !timezone) {
        return null;
    }
    try {
        new Intl.DateTimeFormat('en', {timeZone: timezone}).format(new Date(now));
    } catch {
        return null;
    }
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 1 || hour > 12 || minute > 59) {
        return null;
    }
    hour = hour % 12 + (match[3]!.toLowerCase() === 'pm' ? 12 : 0);
    const local = partsAt(now, timezone);
    let retryAt = localTimeToUtc(local['year']!, local['month']!, local['day']!, hour, minute, timezone);
    if (retryAt < now - 5 * 60_000) {
        const next = new Date(Date.UTC(local['year']!, local['month']! - 1, local['day']! + 1));
        retryAt = localTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, minute, timezone);
    }
    return {retryAt, timezone};
}

function bounded(text: string): string {
    return text.replaceAll(/\s+/g, ' ').trim().slice(0, 512);
}

function processAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function normalizeCooldown(limit: ProviderUsageLimit | ProviderCooldown): ProviderCooldown {
    return {
        ...limit,
        repeatedWithoutLaterReset: 'repeatedWithoutLaterReset' in limit && Number.isSafeInteger(limit.repeatedWithoutLaterReset) ? limit.repeatedWithoutLaterReset : 0,
        wakeAt: 'wakeAt' in limit && (limit.wakeAt === null || Number.isSafeInteger(limit.wakeAt)) ? limit.wakeAt : limit.retryAt
    };
}

export function publicProviderLimit(cooldown: ProviderCooldown): ProviderUsageLimit {
    const {repeatedWithoutLaterReset: _repeated, wakeAt: _wakeAt, probeOwner: _owner, probePid: _pid, probeExpiresAt: _expires, manualTarget: _target, ...limit} = cooldown;
    return limit;
}

/** A repeated signal with no later reset gets one bounded retry, then requires a person. */
export function reconcileProviderCooldown(previous: ProviderCooldown | null, detected: ProviderUsageLimit, now = Date.now(), backoffMs = 60_000, graceMs = 5_000): ProviderCooldown {
    if (!previous || !detected.automaticRetry || detected.retryAt === null) {
        return {...detected, repeatedWithoutLaterReset: 0, wakeAt: detected.retryAt === null ? null : detected.retryAt + graceMs};
    }
    if (previous.manualTarget && detected.retryAt > now + 30_000) {
        return {...detected, repeatedWithoutLaterReset: previous.repeatedWithoutLaterReset, wakeAt: detected.retryAt + graceMs};
    }
    const laterReset = previous.retryAt === null || detected.retryAt > previous.retryAt + 30_000;
    if (laterReset) {
        return {...detected, repeatedWithoutLaterReset: 0, wakeAt: detected.retryAt + graceMs};
    }
    const repeatedWithoutLaterReset = previous.repeatedWithoutLaterReset + 1;
    if (repeatedWithoutLaterReset === 1) {
        const retryAt = Math.max(detected.retryAt, now + Math.max(1_000, backoffMs));
        return {
            ...detected,
            retryAt,
            automaticRetry: true,
            repeatedWithoutLaterReset,
            wakeAt: retryAt,
            displayMessage: `Claude usage limit remains; PairLobby will retry once after bounded backoff at ${new Date(retryAt).toISOString()}.`
        };
    }
    return {
        ...detected,
        automaticRetry: false,
        repeatedWithoutLaterReset,
        wakeAt: null,
        displayMessage: 'Claude usage limit remains after a guarded retry; automatic retry is off. Retry manually after restoring provider capacity.'
    };
}

export function detectClaudeUsageLimit(evidence: ClaudeLimitEvidence): ProviderUsageLimit | null {
    const sources: {source: ProviderLimitSource; text: string}[] = [
        ...(evidence.result ? [{source: 'result' as const, text: evidence.result}] : []),
        ...(evidence.errors?.length ? [{source: 'result_errors' as const, text: evidence.errors.join('\n')}] : []),
        ...(evidence.stderr ? [{source: 'stderr' as const, text: evidence.stderr}] : [])
    ];
    const found = sources.find((candidate) => STRONG_LIMIT.test(candidate.text));
    if (!found) {
        return null;
    }
    const now = evidence.now ?? Date.now();
    const combined = sources.map((candidate) => candidate.text).join('\n');
    const reset = parseResetTime(combined, now, evidence.defaultTimezone);
    const limitKind: ProviderLimitKind = /weekly limit/i.test(combined) ? 'weekly' : /session limit/i.test(combined) ? 'session' : 'unknown';
    const displayMessage = reset
        ? `Claude usage limit reached; limit resets ${new Date(reset.retryAt).toISOString()} (${reset.timezone}).`
        : 'Claude usage limit reached; reset time was not available.';
    return {
        provider: 'claude',
        limitKind,
        detectedAt: now,
        retryAt: reset?.retryAt ?? null,
        resetTimezone: reset?.timezone ?? null,
        displayMessage,
        resetActionUrl: RESET_URL.test(combined) ? 'https://clau.de/reset' : null,
        automaticRetry: Boolean(reset),
        source: found.source
    };
}

function executableIdentity(runtime: string, executable?: string): string {
    const command = executable ?? runtime;
    const candidates = isAbsolute(command) || command.includes('/')
        ? [resolve(command)]
        : (process.env['PATH'] ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, command));
    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            return realpathSync(candidate);
        } catch {
            // Keep looking; an unavailable executable is still represented deterministically below.
        }
    }
    return isAbsolute(command) || command.includes('/') ? resolve(command) : command;
}

export function providerProfileKey(runtime: string, executable?: string): string {
    const configuration = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
    const identity = `${runtime}\0${executableIdentity(runtime, executable)}\0${resolve(configuration)}`;
    return `${runtime}:${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

export class ProviderCooldownStore {
    private readonly database: DatabaseSync;

    constructor(file: string) {
        mkdirSync(dirname(file), {recursive: true, mode: 0o700});
        this.database = new DatabaseSync(file);
        this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS provider_cooldowns(profile_key TEXT PRIMARY KEY, body TEXT NOT NULL);');
    }

    static inDirectory(directory: string): ProviderCooldownStore {
        return new ProviderCooldownStore(join(directory, 'provider-cooldowns.sqlite'));
    }

    get(profileKey: string): ProviderCooldown | null {
        const row = this.database.prepare('SELECT body FROM provider_cooldowns WHERE profile_key=?').get(profileKey) as {body: string} | undefined;
        return row ? normalizeCooldown(JSON.parse(row.body) as ProviderUsageLimit | ProviderCooldown) : null;
    }

    set(profileKey: string, limit: ProviderUsageLimit | ProviderCooldown): void {
        this.database.prepare('INSERT OR REPLACE INTO provider_cooldowns(profile_key,body) VALUES (?,?)').run(profileKey, JSON.stringify(normalizeCooldown(limit)));
    }

    requestRetry(profileKey: string, target: ProviderRetryTarget): ProviderCooldown | null {
        return this.transaction(() => {
            const cooldown = this.get(profileKey);
            if (!cooldown) {
                return null;
            }
            const next: ProviderCooldown = {...cooldown, automaticRetry: true, manualTarget: target};
            delete next.probeOwner;
            delete next.probePid;
            delete next.probeExpiresAt;
            this.set(profileKey, next);
            return next;
        });
    }

    claimDue(input: CooldownClaimInput): ProviderCooldown | null {
        return this.transaction(() => {
            const cooldown = this.get(input.profileKey);
            const due = cooldown?.manualTarget || (cooldown?.automaticRetry && cooldown.wakeAt !== null && input.now >= cooldown.wakeAt);
            if (!cooldown || !due) {
                return null;
            }
            if (cooldown.manualTarget && (cooldown.manualTarget.roomId !== input.roomId || cooldown.manualTarget.participantId !== input.participantId)) {
                return null;
            }
            const activeProbe = cooldown.probeOwner && cooldown.probePid && (cooldown.probeExpiresAt ?? 0) > input.now && processAlive(cooldown.probePid);
            if (activeProbe && cooldown.probeOwner !== input.owner) {
                return null;
            }
            const claimed: ProviderCooldown = {...cooldown, probeOwner: input.owner, probePid: input.pid, probeExpiresAt: input.now + input.leaseMs};
            this.set(input.profileKey, claimed);
            return claimed;
        });
    }

    releaseProbe(profileKey: string, owner: string): boolean {
        return this.transaction(() => {
            const cooldown = this.get(profileKey);
            if (!cooldown || cooldown.probeOwner !== owner) {
                return false;
            }
            delete cooldown.probeOwner;
            delete cooldown.probePid;
            delete cooldown.probeExpiresAt;
            this.set(profileKey, cooldown);
            return true;
        });
    }

    clearManualTarget(profileKey: string, owner: string): boolean {
        return this.transaction(() => {
            const cooldown = this.get(profileKey);
            if (!cooldown || cooldown.probeOwner !== owner || !cooldown.manualTarget) {
                return false;
            }
            delete cooldown.manualTarget;
            delete cooldown.probeOwner;
            delete cooldown.probePid;
            delete cooldown.probeExpiresAt;
            cooldown.automaticRetry = cooldown.retryAt !== null && cooldown.repeatedWithoutLaterReset < 2;
            this.set(profileKey, cooldown);
            return true;
        });
    }

    clear(profileKey: string): void {
        this.database.prepare('DELETE FROM provider_cooldowns WHERE profile_key=?').run(profileKey);
    }

    close(): void {
        this.database.close();
    }

    private transaction<T>(operation: () => T): T {
        this.database.exec('BEGIN IMMEDIATE');
        try {
            const result = operation();
            this.database.exec('COMMIT');
            return result;
        } catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }
}

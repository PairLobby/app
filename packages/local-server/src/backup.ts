//! Copies of the relay's database in a folder or an S3 bucket, taken while it runs and
//! restored when it starts on an empty disk, so a replaced container keeps its rooms.

import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {s3Client} from './s3.js';
import type {S3Client, S3Environment} from './s3.js';

export type BackupLocation = {kind: 'folder'; path: string} | {kind: 's3'; bucket: string; prefix: string};

/** Where copies go. Names are `rooms-<UTC time>.sqlite`, so sorting them sorts them by age. */
export type BackupTarget = {
    description: string;
    put(name: string, file: string): Promise<void>;
    list(): Promise<string[]>;
    /** Writes the copy to `file`. */
    get(name: string, file: string): Promise<void>;
    remove(name: string): Promise<void>;
};

export type BackupInfo = {name: string; takenAt: string};

export type RestoreResult = {outcome: 'restored'; backup: BackupInfo} | {outcome: 'kept-local-data'} | {outcome: 'no-backups'};

export type BackupLogLine = {ts: string; level: 'info' | 'error'; event: 'backup' | 'restore'; name?: string; bytes?: number; ms?: number; error?: string};

export type BackupScheduleOptions = {
    target: BackupTarget;
    /** How often to look for changes; a copy is only taken when something changed. Default one minute. */
    intervalMs?: number;
    /** Copies to keep; older ones are deleted after each new one. Default 48. */
    keep?: number;
    log?: (line: string) => void;
};

/** The store a backup schedule copies, as `SqliteRoomStore` provides it. */
export type BackupSource = {changeCount(): number; snapshot(destination: string): Promise<void>};

type BackupScheduleInput = BackupScheduleOptions & {source: BackupSource; dataFile: string; now?: () => Date};

type RestoreInput = {target: BackupTarget; dataFile: string; log?: (line: string) => void};

export type BackupSchedule = {
    /** Takes a copy now if anything changed since the last one; null when nothing did. */
    run(): Promise<BackupInfo | null>;
    /** Stops the schedule after one last copy, so a relay that is shut down loses nothing. */
    stop(): Promise<void>;
};

export const DEFAULT_BACKUP_INTERVAL_MS = 60_000;

export const DEFAULT_BACKUP_KEEP = 48;

const NAME = /^rooms-(\d{8})T(\d{6})(\d{3})Z\.sqlite$/;

export function backupName(at: Date): string {
    return `rooms-${at.toISOString().replace(/[-:.]/g, '')}.sqlite`;
}

function takenAt(name: string): string {
    const [, day = '', time = '', millis = ''] = NAME.exec(name) ?? [];
    return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}.${millis}Z`;
}

/** `s3://bucket/prefix` or an absolute folder path (`file://` allowed); null for anything else. */
export function parseBackupLocation(value: string): BackupLocation | null {
    if (value.startsWith('s3://')) {
        const [bucket = '', ...rest] = value.slice('s3://'.length).split('/');
        const prefix = rest.filter(Boolean).join('/');
        return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ? {kind: 's3', bucket, prefix: prefix ? `${prefix}/` : ''} : null;
    }
    const path = value.startsWith('file://') ? decodeURIComponent(new URL(value).pathname) : value;
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? {kind: 'folder', path} : null;
}

export function folderTarget(directory: string): BackupTarget {
    return {
        description: directory,
        async put(name, file) {
            mkdirSync(directory, {recursive: true});
            copyFileSync(file, join(directory, `${name}.partial`));
            renameSync(join(directory, `${name}.partial`), join(directory, name));
        },
        async list() {
            return existsSync(directory) ? readdirSync(directory).filter((name) => NAME.test(name)) : [];
        },
        async get(name, file) {
            copyFileSync(join(directory, name), file);
        },
        async remove(name) {
            rmSync(join(directory, name), {force: true});
        }
    };
}

/** Copies are read into memory whole to upload and download them, which suits a team relay's database. */
export function s3Target(bucket: string, prefix: string, client: S3Client): BackupTarget {
    return {
        description: `s3://${bucket}/${prefix}`,
        async put(name, file) {
            await client.putObject(`${prefix}${name}`, readFileSync(file));
        },
        async list() {
            return (await client.listKeys(prefix)).map((key) => key.slice(prefix.length)).filter((name) => NAME.test(name));
        },
        async get(name, file) {
            const bytes = await client.getObject(`${prefix}${name}`);
            if (!bytes) {
                throw new Error(`${prefix}${name} disappeared from s3://${bucket}`);
            }
            writeFileSync(file, bytes);
        },
        async remove(name) {
            await client.deleteObject(`${prefix}${name}`);
        }
    };
}

/** The target for a parsed location. S3 reads its region, credentials and optional endpoint from the environment. */
export function backupTarget(location: BackupLocation, environment: S3Environment = process.env): BackupTarget {
    if (location.kind === 'folder') {
        return folderTarget(location.path);
    }
    const region = environment['AWS_REGION'] || environment['AWS_DEFAULT_REGION'] || 'us-east-1';
    const endpoint = environment['PAIRLOBBY_BACKUP_S3_ENDPOINT'] || undefined;
    return s3Target(location.bucket, location.prefix, s3Client({bucket: location.bucket, region, ...(endpoint ? {endpoint} : {})}));
}

function logLine(log: ((line: string) => void) | undefined, line: Omit<BackupLogLine, 'ts'>): void {
    log?.(JSON.stringify({ts: new Date().toISOString(), ...line}));
}

function isRelayDatabase(file: string): boolean {
    try {
        const db = new DatabaseSync(file, {readOnly: true});
        try {
            const check = db.prepare('PRAGMA quick_check').get() as {quick_check: string} | undefined;
            return check?.quick_check === 'ok' && db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() !== undefined;
        } finally {
            db.close();
        }
    } catch {
        return false;
    }
}

/**
 * Restores the newest sound copy when the relay has no database yet. A database already on
 * disk always wins, since it is at least as new as any copy. A copy that fails its check is
 * skipped for the one before it; failing to reach the target at all throws, so a relay never
 * starts empty while its rooms sit unreachable in a backup.
 */
export async function restoreLatest({target, dataFile, log}: RestoreInput): Promise<RestoreResult> {
    if (existsSync(dataFile)) {
        return {outcome: 'kept-local-data'};
    }
    const names = (await target.list()).sort().reverse();
    if (names.length === 0) {
        return {outcome: 'no-backups'};
    }
    mkdirSync(dirname(dataFile), {recursive: true});
    const partial = `${dataFile}.restore`;
    for (const name of names) {
        const started = Date.now();
        await target.get(name, partial);
        const sound = isRelayDatabase(partial);
        // Opening the copy to check it leaves empty journal files beside it.
        rmSync(`${partial}-wal`, {force: true});
        rmSync(`${partial}-shm`, {force: true});
        if (!sound) {
            rmSync(partial, {force: true});
            logLine(log, {level: 'error', event: 'restore', name, error: 'not a sound relay database; trying the copy before it'});
            continue;
        }
        // A journal left by some other database would be replayed into this one.
        rmSync(`${dataFile}-wal`, {force: true});
        rmSync(`${dataFile}-shm`, {force: true});
        renameSync(partial, dataFile);
        logLine(log, {level: 'info', event: 'restore', name, bytes: statSync(dataFile).size, ms: Date.now() - started});
        return {outcome: 'restored', backup: {name, takenAt: takenAt(name)}};
    }
    throw new Error(`none of the ${names.length} copies in ${target.description} is a sound relay database`);
}

export function startBackups({source, dataFile, target, intervalMs = DEFAULT_BACKUP_INTERVAL_MS, keep = DEFAULT_BACKUP_KEEP, log, now = () => new Date()}: BackupScheduleInput): BackupSchedule {
    // What is on disk now is either new or what was just restored; only later changes need a copy.
    let copiedAt = source.changeCount();
    let inFlight: Promise<BackupInfo | null> | null = null;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const partial = `${dataFile}.backup`;

    const once = async (): Promise<BackupInfo | null> => {
        const changes = source.changeCount();
        if (changes === copiedAt) {
            return null;
        }
        const at = now();
        const name = backupName(at);
        const started = Date.now();
        try {
            rmSync(partial, {force: true});
            await source.snapshot(partial);
            const bytes = statSync(partial).size;
            await target.put(name, partial);
            copiedAt = changes;
            logLine(log, {level: 'info', event: 'backup', name, bytes, ms: Date.now() - started});
            for (const old of (await target.list()).sort().reverse().slice(keep)) {
                await target.remove(old);
            }
            return {name, takenAt: at.toISOString()};
        } catch (error) {
            // The next round tries again: the change count only moves once a copy is stored.
            logLine(log, {level: 'error', event: 'backup', name, error: error instanceof Error ? error.message : String(error)});
            return null;
        } finally {
            rmSync(partial, {force: true});
        }
    };
    const run = () => {
        inFlight ??= once().finally(() => {
            inFlight = null;
        });
        return inFlight;
    };
    const schedule = () => {
        if (stopped) {
            return;
        }
        timer = setTimeout(() => {
            void run().finally(schedule);
        }, intervalMs);
        timer.unref();
    };
    schedule();
    return {
        run,
        async stop() {
            stopped = true;
            clearTimeout(timer);
            await inFlight;
            await run();
        }
    };
}

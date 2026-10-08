//! Append-only execution history for managed receiver requests.
//!
//! `jobs` remains the mutable delivery/outbox state. An attempt header is inserted
//! once, and every later fact is appended to `receiver_attempt_events`; earlier
//! failures are never cleared when a recovery succeeds.

import {randomUUID} from 'node:crypto';
import {existsSync, linkSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {newId} from '@pairlobby/protocol';
import type {ManagedDeadlineSnapshot} from './managed-deadline.js';

export const RECEIVER_ATTEMPT_SCHEMA_VERSION = 1;

export type AttemptTerminalKind = 'answered' | 'passed' | 'declined' | 'cancelled' | 'interrupted' | 'idle_timeout' | 'absolute_timeout' | 'crash' | 'adapter_error' | 'unavailable';

export type AttemptStart = {
    requestEventId: string;
    ordinal: number;
    recoversEventId?: string;
    recoverySourceAttemptId?: string;
    roomId: string;
    participantId: string;
    sessionId: string;
    ownerDeviceId: string;
    runtime: string;
    model?: string;
    effort?: string;
    providerThreadId?: string;
    workingDirectory: string;
    receiverProcessId: number;
    startedAt: number;
    idleTimeoutMs: number;
    absoluteTimeoutMs: number;
};

export type RuntimeStarted = {
    providerThreadId: string;
    turnId: string;
    processId?: number;
    model?: string;
};

export type AttemptTerminal = {
    kind: AttemptTerminalKind;
    at: number;
    failureReason?: string;
    cancellationGraceful?: boolean | null;
    responseEventId?: string;
    deadline?: ManagedDeadlineSnapshot;
};

export type ReceiverAttempt = AttemptStart & {
    attemptId: string;
    schemaVersion: number;
    lastActivityAt: number;
    runtimeStarted?: RuntimeStarted;
    resolvedModel?: string;
    usage?: unknown;
    answerSaved: boolean;
    terminal?: AttemptTerminal;
};

type AttemptRow = {
    attempt_id: string;
    schema_version: number;
    request_event_id: string;
    ordinal: number;
    recovers_event_id: string | null;
    recovery_source_attempt_id: string | null;
    room_id: string;
    participant_id: string;
    session_id: string;
    owner_device_id: string;
    runtime: string;
    model: string | null;
    effort: string | null;
    provider_thread_id: string | null;
    working_directory: string;
    receiver_process_id: number;
    started_at: number;
    idle_timeout_ms: number;
    absolute_timeout_ms: number;
};

type AttemptEventRow = {
    attempt_id: string;
    kind: string;
    at: number;
    payload_json: string;
};

type TerminalPayload = {
    kind: AttemptTerminalKind;
    failureReason?: string;
    cancellationGraceful?: boolean | null;
    responseEventId?: string;
    deadline?: ManagedDeadlineSnapshot;
};

function parsePayload<T>(row: AttemptEventRow): T {
    return JSON.parse(row.payload_json) as T;
}

function jobColumns(database: DatabaseSync): Set<string> {
    const rows = database.prepare('PRAGMA table_info(jobs)').all() as {name: string}[];
    return new Set(rows.map((row) => row.name));
}

export function initializeReceiverDatabase(database: DatabaseSync): void {
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS jobs(event_id TEXT PRIMARY KEY, phase TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, answer TEXT, failure TEXT, turn_id TEXT, attempt_id TEXT);
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receiver_attempts(
            attempt_id TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            request_event_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            recovers_event_id TEXT,
            recovery_source_attempt_id TEXT,
            room_id TEXT NOT NULL,
            participant_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            owner_device_id TEXT NOT NULL,
            runtime TEXT NOT NULL,
            model TEXT,
            effort TEXT,
            provider_thread_id TEXT,
            working_directory TEXT NOT NULL,
            receiver_process_id INTEGER NOT NULL,
            started_at INTEGER NOT NULL,
            idle_timeout_ms INTEGER NOT NULL,
            absolute_timeout_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS receiver_attempt_events(
            journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
            attempt_id TEXT NOT NULL REFERENCES receiver_attempts(attempt_id),
            kind TEXT NOT NULL,
            at INTEGER NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS receiver_attempt_request ON receiver_attempts(request_event_id, ordinal, started_at);
        CREATE INDEX IF NOT EXISTS receiver_attempt_event_order ON receiver_attempt_events(attempt_id, journal_id);
        CREATE UNIQUE INDEX IF NOT EXISTS receiver_attempt_one_terminal ON receiver_attempt_events(attempt_id) WHERE kind='terminal';
        CREATE TRIGGER IF NOT EXISTS receiver_attempts_no_update BEFORE UPDATE ON receiver_attempts BEGIN SELECT RAISE(ABORT, 'receiver attempts are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS receiver_attempts_no_delete BEFORE DELETE ON receiver_attempts BEGIN SELECT RAISE(ABORT, 'receiver attempts are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS receiver_attempt_events_no_update BEFORE UPDATE ON receiver_attempt_events BEGIN SELECT RAISE(ABORT, 'receiver attempt events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS receiver_attempt_events_no_delete BEFORE DELETE ON receiver_attempt_events BEGIN SELECT RAISE(ABORT, 'receiver attempt events are append-only'); END;`);
    if (!jobColumns(database).has('attempt_id')) {
        database.exec('ALTER TABLE jobs ADD COLUMN attempt_id TEXT');
    }
}

/** A random identifier for this PairLobby data directory, never a credential. */
export function localDeviceId(directory: string): string {
    const target = join(directory, 'device-id');
    if (existsSync(target)) {
        const existing = readFileSync(target, 'utf8').trim();
        if (existing) {
            return existing;
        }
        throw new Error(`PairLobby device identifier is empty: ${target}`);
    }
    const identifier = randomUUID();
    const temporary = join(directory, `.device-id-${process.pid}-${identifier}.tmp`);
    writeFileSync(temporary, identifier + '\n', {mode: 0o600});
    try {
        linkSync(temporary, target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    } finally {
        unlinkSync(temporary);
    }
    return readFileSync(target, 'utf8').trim();
}

export class ReceiverAttemptJournal {
    constructor(private readonly database: DatabaseSync) {}

    start(input: AttemptStart): string {
        const attemptId = newId('attempt');
        this.database.prepare(`INSERT INTO receiver_attempts(
            attempt_id, schema_version, request_event_id, ordinal, recovers_event_id, recovery_source_attempt_id,
            room_id, participant_id, session_id, owner_device_id, runtime, model, effort, provider_thread_id,
            working_directory, receiver_process_id, started_at, idle_timeout_ms, absolute_timeout_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            attemptId,
            RECEIVER_ATTEMPT_SCHEMA_VERSION,
            input.requestEventId,
            input.ordinal,
            input.recoversEventId ?? null,
            input.recoverySourceAttemptId ?? null,
            input.roomId,
            input.participantId,
            input.sessionId,
            input.ownerDeviceId,
            input.runtime,
            input.model ?? null,
            input.effort ?? null,
            input.providerThreadId ?? null,
            input.workingDirectory,
            input.receiverProcessId,
            input.startedAt,
            input.idleTimeoutMs,
            input.absoluteTimeoutMs
        );
        return attemptId;
    }

    latestAttemptId(requestEventId: string): string | undefined {
        const row = this.database.prepare('SELECT attempt_id FROM receiver_attempts WHERE request_event_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(requestEventId) as {attempt_id: string} | undefined;
        return row?.attempt_id;
    }

    activity(attemptId: string, snapshot: ManagedDeadlineSnapshot): void {
        this.append(attemptId, 'activity', snapshot.lastActivityAt, snapshot);
    }

    runtimeStarted(attemptId: string, runtime: RuntimeStarted, at = Date.now()): void {
        this.append(attemptId, 'runtime_started', at, runtime);
    }

    model(attemptId: string, model: string, at = Date.now()): void {
        this.append(attemptId, 'model', at, {model});
    }

    usage(attemptId: string, usage: unknown, at = Date.now()): void {
        this.append(attemptId, 'usage', at, {usage});
    }

    answerSaved(attemptId: string, at = Date.now()): void {
        this.append(attemptId, 'answer_saved', at, {});
    }

    terminal(attemptId: string, terminal: AttemptTerminal): boolean {
        const activity = this.database.prepare("SELECT attempt_id, kind, at, payload_json FROM receiver_attempt_events WHERE attempt_id=? AND kind='activity' ORDER BY journal_id DESC LIMIT 1").get(attemptId) as AttemptEventRow | undefined;
        const deadline = terminal.deadline ?? (activity ? parsePayload<ManagedDeadlineSnapshot>(activity) : undefined);
        const payload: TerminalPayload = {
            kind: terminal.kind,
            ...(terminal.failureReason ? {failureReason: terminal.failureReason} : {}),
            ...(terminal.cancellationGraceful !== undefined ? {cancellationGraceful: terminal.cancellationGraceful} : {}),
            ...(terminal.responseEventId ? {responseEventId: terminal.responseEventId} : {}),
            ...(deadline ? {deadline} : {})
        };
        return this.database.prepare("INSERT OR IGNORE INTO receiver_attempt_events(attempt_id, kind, at, payload_json) VALUES (?, 'terminal', ?, ?)").run(attemptId, terminal.at, JSON.stringify(payload)).changes === 1;
    }

    crashRunningJobs(reason: string, at = Date.now()): string[] {
        const rows = this.database.prepare("SELECT attempt_id FROM jobs WHERE phase='running' AND attempt_id IS NOT NULL").all() as {attempt_id: string}[];
        const crashed: string[] = [];
        for (const row of rows) {
            if (this.terminal(row.attempt_id, {kind: 'crash', at, failureReason: reason, cancellationGraceful: null})) {
                crashed.push(row.attempt_id);
            }
        }
        return crashed;
    }

    list(requestEventId?: string): ReceiverAttempt[] {
        const rows = this.database.prepare(`SELECT * FROM receiver_attempts${requestEventId ? ' WHERE request_event_id=?' : ''} ORDER BY started_at, rowid`).all(...(requestEventId ? [requestEventId] : [])) as AttemptRow[];
        if (rows.length === 0) {
            return [];
        }
        const wanted = new Set(rows.map((row) => row.attempt_id));
        const events = this.database.prepare('SELECT attempt_id, kind, at, payload_json FROM receiver_attempt_events ORDER BY journal_id').all() as AttemptEventRow[];
        const byAttempt = new Map<string, AttemptEventRow[]>();
        for (const event of events) {
            if (wanted.has(event.attempt_id)) {
                byAttempt.set(event.attempt_id, [...(byAttempt.get(event.attempt_id) ?? []), event]);
            }
        }
        return rows.map((row) => this.reconstruct(row, byAttempt.get(row.attempt_id) ?? []));
    }

    private append(attemptId: string, kind: string, at: number, payload: unknown): void {
        this.database.prepare('INSERT INTO receiver_attempt_events(attempt_id, kind, at, payload_json) VALUES (?, ?, ?, ?)').run(attemptId, kind, at, JSON.stringify(payload));
    }

    private reconstruct(row: AttemptRow, events: AttemptEventRow[]): ReceiverAttempt {
        const attempt: ReceiverAttempt = {
            attemptId: row.attempt_id,
            schemaVersion: row.schema_version,
            requestEventId: row.request_event_id,
            ordinal: row.ordinal,
            ...(row.recovers_event_id ? {recoversEventId: row.recovers_event_id} : {}),
            ...(row.recovery_source_attempt_id ? {recoverySourceAttemptId: row.recovery_source_attempt_id} : {}),
            roomId: row.room_id,
            participantId: row.participant_id,
            sessionId: row.session_id,
            ownerDeviceId: row.owner_device_id,
            runtime: row.runtime,
            ...(row.model ? {model: row.model} : {}),
            ...(row.effort ? {effort: row.effort} : {}),
            ...(row.provider_thread_id ? {providerThreadId: row.provider_thread_id} : {}),
            workingDirectory: row.working_directory,
            receiverProcessId: row.receiver_process_id,
            startedAt: row.started_at,
            lastActivityAt: row.started_at,
            idleTimeoutMs: row.idle_timeout_ms,
            absoluteTimeoutMs: row.absolute_timeout_ms,
            answerSaved: false
        };
        for (const event of events) {
            if (event.kind === 'activity') {
                attempt.lastActivityAt = parsePayload<ManagedDeadlineSnapshot>(event).lastActivityAt;
            } else if (event.kind === 'runtime_started') {
                attempt.runtimeStarted = parsePayload<RuntimeStarted>(event);
                if (attempt.runtimeStarted.model) {
                    attempt.resolvedModel = attempt.runtimeStarted.model;
                }
            } else if (event.kind === 'model') {
                attempt.resolvedModel = parsePayload<{model: string}>(event).model;
            } else if (event.kind === 'usage') {
                attempt.usage = parsePayload<{usage: unknown}>(event).usage;
            } else if (event.kind === 'answer_saved') {
                attempt.answerSaved = true;
            } else if (event.kind === 'terminal') {
                const payload = parsePayload<TerminalPayload>(event);
                attempt.terminal = {kind: payload.kind, at: event.at, ...(payload.failureReason ? {failureReason: payload.failureReason} : {}), ...(payload.cancellationGraceful !== undefined ? {cancellationGraceful: payload.cancellationGraceful} : {}), ...(payload.responseEventId ? {responseEventId: payload.responseEventId} : {}), ...(payload.deadline ? {deadline: payload.deadline} : {})};
            }
        }
        return attempt;
    }
}

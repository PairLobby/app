import {spawn} from 'node:child_process';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';
import type {LocalStore} from '@pairlobby/client';
import {ProtocolError, newId} from '@pairlobby/protocol';
import type {MessageRequest} from '@pairlobby/protocol';
import {select, UsageError} from './context.js';
import {CodexReceiver} from './codex-receiver.js';
import {ClaudeReceiver} from './claude-receiver.js';
import {QwenReceiver} from './qwen-receiver.js';
import {receiverRuntimeName} from './receiver-runtime.js';
import type {ReceiverRuntime, ReceiverRuntimeName} from './receiver-runtime.js';

export type ReceiverStatus = {pid: number; state: string; runtime: string; threadId?: string; eventId?: string; detail?: string; usage?: unknown};
type Job = {event_id: string; phase: string; acknowledged: number; answer: string | null; failure: string | null};
type ReceiverConfiguration = {runtime: ReceiverRuntimeName; cwd: string; model?: string};
type ReceiverPaths = {directory: string; status: string; lock: string; stop: string; log: string; config: string; database: string};

function paths(store: LocalStore, sessionId: string): ReceiverPaths {
    if (!/^se_[A-Z0-9]+$/.test(sessionId)) {
        throw new UsageError('Invalid receiver session');
    }
    const directory = join(store.directory, 'receivers', sessionId);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    return {directory, status: join(directory, 'status.json'), lock: join(directory, 'owner.lock'), stop: join(directory, 'stop'), log: join(directory, 'receiver.log'), config: join(directory, 'config.json'), database: join(directory, 'inbox.sqlite')};
}

function alive(pid: number): boolean {
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

function writePrivate(file: string, value: unknown): void {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value) + '\n', {mode: 0o600});
    renameSync(temporary, file);
}

export function receiverStatus(store: LocalStore, sessionId: string): ReceiverStatus | null {
    const location = paths(store, sessionId);
    try {
        const status = JSON.parse(readFileSync(location.status, 'utf8')) as ReceiverStatus;
        if (!alive(status.pid) || !existsSync(location.lock) || Number(readFileSync(location.lock, 'utf8')) !== status.pid) {
            return {...status, state: 'offline'};
        }
        return status;
    } catch {
        return null;
    }
}

export async function startReceiver(store: LocalStore, roomRef: string, sessionRef: string, model?: string, workdir?: string): Promise<ReceiverStatus> {
    const {room, session} = select(store, roomRef, sessionRef);
    const runtimeName = receiverRuntimeName(session.runtime);
    if (session.kind !== 'agent' || session.role === 'guest' || !runtimeName) {
        throw new UsageError('Automatic receiving requires a Codex, Claude or Qwen agent member. Join with --runtime codex, --runtime claude or --runtime qwen.');
    }
    const channelLock = join(store.directory, `channel-${session.sessionId}.lock`);
    if (existsSync(channelLock) && alive(Number(readFileSync(channelLock, 'utf8')))) {
        throw new UsageError('The native channel already owns this participant. Stop it before starting a managed receiver.');
    }
    const existing = receiverStatus(store, session.sessionId);
    if (existing && !['offline', 'stopped', 'error'].includes(existing.state)) {
        return existing;
    }
    const location = paths(store, session.sessionId);
    if (existsSync(location.lock) && alive(Number(readFileSync(location.lock, 'utf8')))) {
        throw new UsageError('A runtime already owns this participant. Stop its channel before starting a managed receiver.');
    }
    let previous: ReceiverConfiguration | undefined;
    if (existsSync(location.config)) {
        previous = JSON.parse(readFileSync(location.config, 'utf8')) as ReceiverConfiguration;
        if (previous.runtime !== runtimeName) {
            throw new UsageError('This receiver belongs to a different runtime; use a separate room membership.');
        }
    }
    const cwd = realpathSync(workdir ? resolve(workdir) : previous?.cwd ?? session.cwd);
    if (!statSync(cwd).isDirectory()) {
        throw new UsageError('Receiver workdir must be an existing directory');
    }
    if (previous && previous.cwd !== cwd && existsSync(location.database)) {
        throw new UsageError('An existing receiver cannot change project scope; use a separate membership.');
    }
    const selectedModel = model ?? previous?.model;
    const config: ReceiverConfiguration = {runtime: runtimeName, cwd, ...(selectedModel ? {model: selectedModel} : {})};
    writePrivate(location.config, config);
    if (existsSync(location.stop)) {
        unlinkSync(location.stop);
    }
    const log = openSync(location.log, 'a', 0o600);
    const child = spawn(process.execPath, [resolve(process.argv[1]!), 'receiver-run', '--room', room.roomId, '--session', session.sessionId], {
        cwd,
        detached: true,
        stdio: ['ignore', log, log],
        env: {...process.env, PAIRLOBBY_DATA_DIR: store.directory, PAIRLOBBY_ROOM: room.roomId, PAIRLOBBY_SESSION: session.sessionId}
    });
    closeSync(log);
    let startupError: Error | undefined;
    child.on('error', (error) => { startupError = error; });
    child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
        if (startupError) {
            throw startupError;
        }
        const status = receiverStatus(store, session.sessionId);
        if (status && !['offline', 'starting', 'stopped'].includes(status.state)) {
            if (status.state === 'error') {
                throw new UsageError(status.detail ?? 'Receiver startup failed');
            }
            return status;
        }
        await sleep(100);
    }
    throw new UsageError(`Receiver did not start. See ${location.log}`);
}

export async function stopReceiver(store: LocalStore, sessionId: string): Promise<void> {
    const location = paths(store, sessionId);
    writeFileSync(location.stop, '', {mode: 0o600});
    for (let attempt = 0; attempt < 60; attempt++) {
        if (!existsSync(location.lock)) {
            return;
        }
        await sleep(100);
    }
    throw new UsageError('Stop requested, but receiver has not exited yet. Inspect pairlobby receiver status.');
}

/** One ordinary process owns the participant; neither timers nor empty reads start a turn. */
export async function runReceiver(store: LocalStore, roomRef: string, sessionRef: string): Promise<number> {
    const {room, session, credential, client} = select(store, roomRef, sessionRef);
    const location = paths(store, session.sessionId);
    const config = JSON.parse(readFileSync(location.config, 'utf8')) as ReceiverConfiguration;
    let lock: number;
    try {
        lock = openSync(location.lock, 'wx', 0o600);
    } catch {
        const pid = Number(readFileSync(location.lock, 'utf8'));
        if (alive(pid) || !Number.isSafeInteger(pid) || pid <= 0) {
            throw new UsageError('A receiver already owns this participant, or its lock needs inspection');
        }
        unlinkSync(location.lock);
        lock = openSync(location.lock, 'wx', 0o600);
    }
    writeFileSync(lock, String(process.pid));
    closeSync(lock);
    const database = new DatabaseSync(location.database);
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS jobs(event_id TEXT PRIMARY KEY, phase TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, answer TEXT, failure TEXT, turn_id TEXT);
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    database.exec("UPDATE jobs SET phase='failed', failure='Receiver restarted during execution. Outcome is uncertain; not automatically rerun.' WHERE phase='running'");
    let state: ReceiverStatus = {pid: process.pid, state: 'starting', runtime: config.runtime};
    const status = (update: Partial<ReceiverStatus>) => {
        const next = {...state, ...update};
        if (JSON.stringify(next) !== JSON.stringify(state) || !existsSync(location.status)) {
            writePrivate(location.status, next);
        }
        state = next;
    };
    let stopped = false;
    let runtime: ReceiverRuntime | undefined;
    const stop = () => {
        stopped = true;
        runtime?.close();
        client.closeLive();
    };
    const timer = setInterval(() => {
        if (existsSync(location.stop)) {
            stop();
        }
    }, 250);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);

    function savedValue(key: string): string | undefined {
        return database.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.['value'] as string | undefined;
    }

    function saveValue(key: string, value: string): void {
        database.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(key, value);
    }

    async function flush(): Promise<void> {
        const jobs = database.prepare("SELECT * FROM jobs WHERE phase IN ('reply', 'failed', 'pass')").all() as Job[];
        if (jobs.length === 0) {
            return;
        }
        const snapshot = await client.snapshot(room.roomId, credential);
        const member = snapshot.participants.find((participant) => participant.participantId === session.participantId);
        if (member?.muted) {
            return;
        }
        for (const job of jobs) {
            const token = savedValue(`turn:${job.event_id}`);
            try {
                if (job.phase === 'reply') {
                    await client.reply(room.roomId, credential, job.event_id, job.answer!, false, token);
                } else if (job.phase === 'pass' && token) {
                    await client.passTurn(room.roomId, credential, job.event_id, token);
                } else {
                    await client.deliveryFailed(room.roomId, credential, job.event_id, job.failure ?? 'Execution failed', token);
                }
                database.prepare("UPDATE jobs SET phase='done' WHERE event_id=?").run(job.event_id);
            } catch (error) {
                if (error instanceof ProtocolError && ['turn_required', 'turn_expired'].includes(error.code)) {
                    database.prepare("UPDATE jobs SET phase='withheld', failure=? WHERE event_id=?").run('Speaking turn ended; saved output was not posted.', job.event_id);
                    status({detail: 'Speaking turn ended; saved output was not posted.'});
                } else {
                    throw error;
                }
            }
        }
    }

    async function execute(request: MessageRequest): Promise<void> {
        // Re-read authorization and obligation immediately before dispatch.
        const snapshot = await client.snapshot(room.roomId, credential);
        const member = snapshot.participants.find((participant) => participant.participantId === session.participantId);
        if (!member || member.paused || member.muted || member.revoked || member.left) {
            return;
        }
        let current = await client.request(room.roomId, credential, request.eventId);
        if (current.responseEventId || current.failureAt || !current.requiresReply) {
            return;
        }
        database.prepare("INSERT OR IGNORE INTO jobs(event_id, phase) VALUES (?, 'queued')").run(request.eventId);
        const job = database.prepare('SELECT * FROM jobs WHERE event_id=?').get(request.eventId) as Job;
        if (job.phase !== 'queued') {
            return;
        }
        let token: string | undefined;
        if (snapshot.groupTurnsSupported) {
            const claimId = savedValue(`claim:${request.eventId}`) ?? newId('event');
            saveValue(`claim:${request.eventId}`, claimId);
            const grant = await client.claimTurn(room.roomId, credential, request.eventId, claimId);
            if (grant.state !== 'granted') {
                status({state: grant.state === 'stalled' ? 'stalled' : 'waiting', eventId: request.eventId, detail: 'Waiting for a speaking turn.'});
                return;
            }
            token = grant.token!;
            saveValue(`turn:${request.eventId}`, token);
            current = grant.request ?? current;
        }
        let leaseFailure: Error | undefined;
        let renewing = false;
        let renewal: Promise<void> = Promise.resolve();
        const heartbeat = token ? setInterval(() => {
            if (renewing) {
                return;
            }
            renewing = true;
            renewal = client.renewTurn(room.roomId, credential, request.eventId, token!).then(() => {}).catch((error: unknown) => {
                if (error instanceof ProtocolError && error.code === 'turn_conflict') {
                    return;
                }
                leaseFailure = error instanceof Error ? error : new Error('Speaking turn could not be renewed');
                runtime?.close();
            }).finally(() => { renewing = false; });
        }, 10_000) : undefined;
        database.prepare("UPDATE jobs SET phase='running' WHERE event_id=?").run(request.eventId);
        status({state: 'working', eventId: request.eventId, detail: ''});
        try {
            if (!runtime) {
                const saved = database.prepare("SELECT value FROM metadata WHERE key='thread'").get() as {value: string} | undefined;
                const runtimeOptions = {cwd: config.cwd, roomId: room.roomId, sessionId: session.sessionId, ...(saved ? {threadId: saved.value} : {}), ...(config.model ? {model: config.model} : {})};
                const mcpOptions = {...runtimeOptions, stateDirectory: location.directory, cliPath: resolve(process.argv[1]!), dataDirectory: store.directory, roomId: room.roomId, sessionId: session.sessionId};
                if (config.runtime === 'qwen') {
                    runtime = new QwenReceiver(mcpOptions);
                } else if (config.runtime === 'claude') {
                    runtime = new ClaudeReceiver(mcpOptions);
                } else {
                    runtime = new CodexReceiver(runtimeOptions);
                }
                const threadId = await runtime.connect();
                database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('thread', ?)").run(threadId);
                status({threadId});
            }
            const answer = await runtime.execute(current, {
                acknowledge: async () => {
                    await client.acknowledgeMessage(room.roomId, credential, request.eventId);
                    database.prepare('UPDATE jobs SET acknowledged=1 WHERE event_id=?').run(request.eventId);
                },
                pass: async () => {
                    if (!token) {
                        throw new Error('This relay does not support passing turns');
                    }
                    await client.acknowledgeMessage(room.roomId, credential, request.eventId);
                    database.prepare('UPDATE jobs SET acknowledged=1 WHERE event_id=?').run(request.eventId);
                    saveValue(`pass:${request.eventId}`, '1');
                },
                started: (turnId) => { database.prepare('UPDATE jobs SET turn_id=? WHERE event_id=?').run(turnId, request.eventId); },
                usage: (usage) => status({usage})
            });
            if (config.runtime === 'qwen' && !database.prepare('SELECT acknowledged FROM jobs WHERE event_id=?').get(request.eventId)?.['acknowledged']) {
                if (runtime instanceof QwenReceiver) {
                    runtime.discardSession();
                }
                throw new Error('Qwen completed without explicitly acknowledging the request; no receipt or reply was fabricated.');
            }
            if (leaseFailure) {
                throw leaseFailure;
            }
            // Persist before transmission; retries reuse the server's reply idempotency key.
            database.prepare('UPDATE jobs SET phase=?, answer=? WHERE event_id=?').run(savedValue(`pass:${request.eventId}`) === '1' ? 'pass' : 'reply', answer, request.eventId);
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'Runtime failed';
            database.prepare("UPDATE jobs SET phase='failed', failure=? WHERE event_id=?").run(reason, request.eventId);
            runtime?.close();
            runtime = undefined;
            status({detail: reason});
        } finally {
            clearInterval(heartbeat);
            await renewal;
        }
        await flush();
        status({state: 'available', eventId: ''});
    }

    try {
        await client.snapshot(room.roomId, credential);
        status({state: 'available'});
        let failures = 0;
        while (!stopped) {
            try {
                await flush();
                const snapshot = await client.snapshot(room.roomId, credential);
                const member = snapshot.participants.find((participant) => participant.participantId === session.participantId);
                if (!member || member.revoked || member.left) {
                    break;
                }
                let waiting = false;
                if (!member.paused && !member.muted) {
                    const requests = await client.pendingRequests(room.roomId, credential, session.participantId);
                    for (const request of requests) {
                        if (stopped) {
                            break;
                        }
                        if (request.failureAt) {
                            continue;
                        }
                        await execute(request);
                        if (['waiting', 'stalled'].includes(state.state) && state.eventId === request.eventId) {
                            waiting = true;
                            break;
                        }
                    }
                }
                status({state: member.paused || member.muted ? 'paused' : waiting ? state.state : 'available', eventId: waiting ? state.eventId ?? '' : '', detail: !waiting && state.detail === 'Waiting for a speaking turn.' ? '' : state.detail ?? ''});
                failures = 0;
                await client.waitForChange(room.roomId, credential, snapshot.latestSeq, 300_000, 1000);
            } catch (error) {
                if (stopped) {
                    break;
                }
                if (error instanceof ProtocolError && ['room_expired', 'room_closed', 'room_not_found', 'participant_revoked', 'unauthorized'].includes(error.code)) {
                    throw error;
                }
                status({state: 'reconnecting', detail: error instanceof Error ? error.message : 'Relay unavailable'});
                client.closeLive();
                await sleep(Math.min(5000, 250 * 2 ** Math.min(failures++, 5)));
            }
        }
        status({state: 'stopped'});
        return 0;
    } catch (error) {
        status({state: 'error', detail: error instanceof Error ? error.message : 'Receiver failed'});
        return 1;
    } finally {
        stop();
        clearInterval(timer);
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
        database.close();
        unlinkSync(location.lock);
    }
}

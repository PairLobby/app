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
import {RuntimeInterrupted, receiverRuntimeName} from './receiver-runtime.js';
import type {InterruptOutcome, ReceiverRuntime, ReceiverRuntimeName} from './receiver-runtime.js';
import {validateEffort} from './spawn-options.js';
import {startReceiptMonitor} from './receipt-monitor.js';
import type {ReceiptMonitor} from './receipt-monitor.js';
import {modelId, savedSessionModel} from './model-metadata.js';
import {ManagedDeadlineExpired, validateManagedDeadline} from './managed-deadline.js';
import type {ManagedDeadlinePolicy, ManagedDeadlineSnapshot} from './managed-deadline.js';
import {ReceiverAttemptJournal, initializeReceiverDatabase, localDeviceId} from './receiver-attempt-journal.js';
import type {AttemptTerminal, AttemptTerminalKind} from './receiver-attempt-journal.js';

export type ReceiverStatus = {pid: number; state: string; runtime: string; threadId?: string; model?: string; eventId?: string; attempt?: number | null; attemptId?: string | null; detail?: string; receiptError?: string; usage?: unknown; idleTimeoutMs?: number; absoluteTimeoutMs?: number; requestStartedAt?: number | null; lastActivityAt?: number | null; idleDeadlineAt?: number | null; absoluteDeadlineAt?: number | null; idleRemainingMs?: number | null; absoluteRemainingMs?: number | null};
export type ReceiverStartOptions = {model?: string; workdir?: string; effort?: string; executable?: string; idleTimeoutMs?: number; absoluteTimeoutMs?: number};
type Job = {event_id: string; phase: string; acknowledged: number; answer: string | null; failure: string | null; attempt_id: string | null};
type ReceiverConfiguration = {runtime: ReceiverRuntimeName; cwd: string; model?: string; effort?: string; executable?: string; idleTimeoutMs: number; absoluteTimeoutMs: number};
type ReceiverPaths = {directory: string; status: string; lock: string; stop: string; log: string; config: string; database: string};
const JOURNAL_ACTIVITY_INTERVAL_MS = 5_000;

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

function attemptTerminalKind(error: unknown): AttemptTerminalKind {
    if (error instanceof ManagedDeadlineExpired) {
        return error.kind === 'idle' ? 'idle_timeout' : 'absolute_timeout';
    }
    if (error instanceof RuntimeInterrupted) {
        return 'interrupted';
    }
    const message = error instanceof Error ? error.message : String(error);
    return /not on PATH|could not be started|missing required options|busy or unavailable/i.test(message) ? 'unavailable' : 'adapter_error';
}

export function receiverConfiguration(store: LocalStore, sessionId: string): ReceiverConfiguration | null {
    if (!/^se_[A-Z0-9]+$/.test(sessionId)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(join(store.directory, 'receivers', sessionId, 'config.json'), 'utf8')) as ReceiverConfiguration;
    } catch {
        return null;
    }
}

export function receiverStatus(store: LocalStore, sessionId: string): ReceiverStatus | null {
    const location = paths(store, sessionId);
    try {
        const status = JSON.parse(readFileSync(location.status, 'utf8')) as ReceiverStatus;
        const now = Date.now();
        const withRemaining = {...status, idleRemainingMs: status.idleDeadlineAt ? Math.max(0, status.idleDeadlineAt - now) : null, absoluteRemainingMs: status.absoluteDeadlineAt ? Math.max(0, status.absoluteDeadlineAt - now) : null};
        if (!alive(status.pid) || !existsSync(location.lock) || Number(readFileSync(location.lock, 'utf8')) !== status.pid) {
            return {...withRemaining, state: status.state === 'stopped' ? 'stopped' : 'offline'};
        }
        return withRemaining;
    } catch {
        return null;
    }
}

export function receiverAttempts(store: LocalStore, sessionId: string, requestEventId?: string): ReturnType<ReceiverAttemptJournal['list']> {
    const databaseFile = paths(store, sessionId).database;
    if (!existsSync(databaseFile)) {
        return [];
    }
    const database = new DatabaseSync(databaseFile, {readOnly: true});
    try {
        const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='receiver_attempts'").get();
        return table ? new ReceiverAttemptJournal(database).list(requestEventId) : [];
    } finally {
        database.close();
    }
}

export async function startReceiver(store: LocalStore, roomRef: string, sessionRef: string, options: ReceiverStartOptions = {}): Promise<ReceiverStatus> {
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
    const cwd = realpathSync(options.workdir ? resolve(options.workdir) : previous?.cwd ?? session.cwd);
    if (!statSync(cwd).isDirectory()) {
        throw new UsageError('Receiver workdir must be an existing directory');
    }
    if (previous && previous.cwd !== cwd && existsSync(location.database)) {
        throw new UsageError('An existing receiver cannot change project scope; use a separate membership.');
    }
    const selectedModel = options.model ?? previous?.model;
    const selectedEffort = options.effort ?? previous?.effort;
    if (selectedEffort) {
        validateEffort(runtimeName, selectedEffort);
    }
    const selectedExecutable = options.executable ?? previous?.executable;
    const settings = store.settings();
    const deadline = validateManagedDeadline({idleMs: options.idleTimeoutMs ?? previous?.idleTimeoutMs ?? settings.managedTaskIdleMs, absoluteMs: options.absoluteTimeoutMs ?? previous?.absoluteTimeoutMs ?? settings.managedTaskTimeoutMs});
    const config: ReceiverConfiguration = {runtime: runtimeName, cwd, idleTimeoutMs: deadline.idleMs, absoluteTimeoutMs: deadline.absoluteMs, ...(selectedModel ? {model: selectedModel} : {}), ...(selectedEffort ? {effort: selectedEffort} : {}), ...(selectedExecutable ? {executable: selectedExecutable} : {})};
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
    initializeReceiverDatabase(database);
    const attemptJournal = new ReceiverAttemptJournal(database);
    const restartFailure = 'Receiver restarted during execution. Outcome is uncertain; not automatically rerun.';
    const runningJobs = Number(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE phase='running'").get()?.['count'] ?? 0);
    attemptJournal.crashRunningJobs(restartFailure);
    database.prepare("UPDATE jobs SET phase='failed', failure=? WHERE phase='running'").run(restartFailure);
    if (runningJobs) {
        database.prepare("DELETE FROM metadata WHERE key='thread'").run();
    }
    const ownerDeviceId = localDeviceId(store.directory);
    const savedThread = database.prepare("SELECT value FROM metadata WHERE key='thread'").get() as {value: string} | undefined;
    const savedModel = database.prepare("SELECT value FROM metadata WHERE key='model'").get() as {value: string} | undefined;
    const recoveredModel = modelId(savedModel?.value) ?? (savedThread ? savedSessionModel({runtime: config.runtime, threadId: savedThread.value, cwd: config.cwd}) : undefined);
    if (recoveredModel && savedModel?.value !== recoveredModel) {
        database.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('model',?)").run(recoveredModel);
    }
    let state: ReceiverStatus = {pid: process.pid, state: 'starting', runtime: config.runtime, idleTimeoutMs: config.idleTimeoutMs, absoluteTimeoutMs: config.absoluteTimeoutMs, attempt: null, attemptId: null, requestStartedAt: null, lastActivityAt: null, idleDeadlineAt: null, absoluteDeadlineAt: null, ...(savedThread ? {threadId: savedThread.value} : {}), ...(recoveredModel ? {model: recoveredModel} : {})};
    const status = (update: Partial<ReceiverStatus>) => {
        const next = {...state, ...update};
        if (JSON.stringify(next) !== JSON.stringify(state) || !existsSync(location.status)) {
            writePrivate(location.status, next);
        }
        state = next;
    };
    let stopped = false;
    let receipts: ReceiptMonitor | undefined;
    let runtime: ReceiverRuntime | undefined;
    const stop = () => {
        stopped = true;
        runtime?.close();
        client.closeLive();
        void receipts?.stop();
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

    function deleteValue(key: string): void {
        database.prepare('DELETE FROM metadata WHERE key=?').run(key);
    }

    /** Reports what an interrupt really stopped. The revision makes a retry or a late report harmless. */
    async function acknowledgeControl(revision: number, outcome: InterruptOutcome): Promise<void> {
        await client.send(room.roomId, credential, {type: 'control.ack', payload: {targetParticipantId: session.participantId, revision, outcome}, idempotencyKey: `control-ack-${session.participantId}-${revision}`});
    }

    async function flush(): Promise<void> {
        const jobs = database.prepare("SELECT * FROM jobs WHERE phase IN ('reply', 'failed', 'pass', 'decision')").all() as Job[];
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
                const current = await client.request(room.roomId, credential, job.event_id);
                if (current.responseEventId || !current.requiresReply) {
                    if (job.attempt_id) {
                        attemptJournal.terminal(job.attempt_id, current.responseEventId
                            ? {kind: 'answered', at: current.respondedAt ?? Date.now(), responseEventId: current.responseEventId}
                            : {kind: 'cancelled', at: Date.now(), failureReason: 'The request no longer requires a reply.'});
                    }
                    database.prepare("UPDATE jobs SET phase='done' WHERE event_id=?").run(job.event_id);
                    continue;
                }
                if (job.phase === 'reply') {
                    if (snapshot.messageStagesSupported && current.action !== 'reply_pending') {
                        await client.reportMessageStatus(room.roomId, credential, job.event_id, 'reply_pending', token ? {turnToken: token} : {});
                    }
                    const response = await client.reply(room.roomId, credential, job.event_id, job.answer!, false, token);
                    if (job.attempt_id) {
                        attemptJournal.terminal(job.attempt_id, {kind: 'answered', at: response.event.at, responseEventId: response.event.eventId});
                    }
                } else if (job.phase === 'decision') {
                    const decision = JSON.parse(savedValue(`decision:${job.event_id}`)!) as {state: 'no_action' | 'declined'; reason: string};
                    await client.reportMessageStatus(room.roomId, credential, job.event_id, decision.state, {reason: decision.reason, ...(token ? {turnToken: token} : {})});
                    if (job.attempt_id) {
                        attemptJournal.terminal(job.attempt_id, {kind: decision.state === 'declined' ? 'declined' : 'passed', at: Date.now(), failureReason: decision.reason});
                    }
                } else if (job.phase === 'pass' && token) {
                    if (snapshot.messageStagesSupported) {
                        await client.reportMessageStatus(room.roomId, credential, job.event_id, 'no_action', {reason: 'Agent explicitly passed: nothing further to add.', turnToken: token});
                    } else {
                        await client.passTurn(room.roomId, credential, job.event_id, token);
                    }
                    if (job.attempt_id) {
                        attemptJournal.terminal(job.attempt_id, {kind: 'passed', at: Date.now()});
                    }
                } else {
                    await client.deliveryFailed(room.roomId, credential, job.event_id, job.failure ?? 'Execution failed', token, 'execution');
                }
                database.prepare("UPDATE jobs SET phase='done' WHERE event_id=?").run(job.event_id);
            } catch (error) {
                if (error instanceof ProtocolError && ['turn_required', 'turn_expired'].includes(error.code)) {
                    database.prepare("UPDATE jobs SET phase='withheld', failure=? WHERE event_id=?").run('Speaking turn ended; saved output was not posted.', job.event_id);
                    if (job.attempt_id) {
                        attemptJournal.terminal(job.attempt_id, {kind: 'cancelled', at: Date.now(), failureReason: 'Speaking turn ended; saved output was not posted.'});
                    }
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
        let interrupting: Promise<void> | undefined;
        let interruptOutcome: InterruptOutcome | undefined;
        let requestCancelled = false;
        let watching = true;
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
                // An interrupt fences the turn on purpose; let the interrupt stop the runtime and report it.
                if (!interrupting) {
                    runtime?.close();
                }
            }).finally(() => { renewing = false; });
        }, 10_000) : undefined;
        const previousThreadId = savedValue('thread');
        const startedAt = Date.now();
        const recoverySourceAttemptId = current.recoversEventId ? attemptJournal.latestAttemptId(current.recoversEventId) : undefined;
        let attemptId: string;
        database.exec('BEGIN IMMEDIATE');
        try {
            attemptId = attemptJournal.start({
                requestEventId: current.eventId,
                ordinal: current.attempt ?? 1,
                ...(current.recoversEventId ? {recoversEventId: current.recoversEventId, ...(recoverySourceAttemptId ? {recoverySourceAttemptId} : {})} : {}),
                roomId: room.roomId,
                participantId: session.participantId,
                sessionId: session.sessionId,
                ownerDeviceId,
                runtime: config.runtime,
                ...(config.model ? {model: config.model} : {}),
                ...(config.effort ? {effort: config.effort} : {}),
                ...(previousThreadId ? {providerThreadId: previousThreadId} : {}),
                workingDirectory: config.cwd,
                receiverProcessId: process.pid,
                startedAt,
                idleTimeoutMs: config.idleTimeoutMs,
                absoluteTimeoutMs: config.absoluteTimeoutMs
            });
            database.prepare("UPDATE jobs SET phase='running', attempt_id=? WHERE event_id=?").run(attemptId, request.eventId);
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            throw error;
        }
        status({state: 'working', eventId: request.eventId, attempt: current.attempt ?? 1, attemptId, detail: ''});
        let lastStatusActivityWrite = 0;
        let lastJournalActivityWrite = startedAt;
        let lastJournalActivityAt = startedAt;
        let lastDeadlineSnapshot: ManagedDeadlineSnapshot | undefined;
        let terminal: AttemptTerminal | undefined;
        let attemptModel: string | undefined;
        try {
            if (!runtime) {
                const saved = database.prepare("SELECT value FROM metadata WHERE key='thread'").get() as {value: string} | undefined;
                const runtimeOptions = {cwd: config.cwd, roomId: room.roomId, sessionId: session.sessionId, deadline: {idleMs: config.idleTimeoutMs, absoluteMs: config.absoluteTimeoutMs}, ...(saved ? {threadId: saved.value} : {}), ...(config.model ? {model: config.model} : {}), ...(config.effort ? {effort: config.effort} : {}), ...(config.executable ? {executable: config.executable} : {})};
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
                if (runtime.model) {
                    database.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('model',?)").run(runtime.model);
                    status({model: runtime.model});
                }
            }
            if (runtime.model) {
                attemptModel = runtime.model;
            }
            // Watch the room while the turn runs: an interrupt for this participant stops
            // the turn now instead of waiting for it to finish. Started before execute()
            // returns control, so a request the runtime has begun is always reachable.
            const active = runtime;
            void (async () => {
                let cursor = snapshot.latestSeq;
                while (watching) {
                    await client.waitForChange(room.roomId, credential, cursor, 30_000, 1000);
                    if (!watching) {
                        return;
                    }
                    const page = await client.readEvents(room.roomId, credential, cursor, 200);
                    for (const event of page.events) {
                        cursor = Math.max(cursor, event.seq);
                        if (event.type === 'control.pause' && event.payload.interrupt && event.payload.targetParticipantId === session.participantId) {
                            watching = false;
                            status({detail: 'Interrupt requested; stopping the current turn.'});
                            interrupting = active.interrupt().then(async (outcome) => {
                                interruptOutcome = outcome;
                                await acknowledgeControl(event.payload.revision, outcome);
                            });
                            await interrupting;
                            return;
                        }
                        if (event.type === 'message.request_closed' && event.payload.outcome === 'cancelled' && event.payload.eventId === request.eventId) {
                            watching = false;
                            requestCancelled = true;
                            status({detail: 'Request cancelled; stopping the current turn.'});
                            interrupting = active.interrupt().then((outcome) => { interruptOutcome = outcome; });
                            await interrupting;
                            return;
                        }
                    }
                }
            })().catch((error: unknown) => status({detail: `Interrupt watch: ${error instanceof Error ? error.message : String(error)}`}));
            const runtimeRequest = current.recoversEventId ? {...current, text: `${current.text}\n\nReceiver-confirmed workspace: ${config.cwd}`} : current;
            const answer = await runtime.execute(runtimeRequest, {
                acknowledge: async () => {
                    await client.acknowledgeMessage(room.roomId, credential, request.eventId);
                    if (snapshot.messageStagesSupported) {
                        await client.reportMessageStatus(room.roomId, credential, request.eventId, 'read');
                    }
                    database.prepare('UPDATE jobs SET acknowledged=1 WHERE event_id=?').run(request.eventId);
                },
                working: async () => {
                    if (!snapshot.workingStatusSupported || !token) {
                        throw new Error('Update this relay to declare working status');
                    }
                    await client.declareWorking(room.roomId, credential, request.eventId, token);
                    if (snapshot.messageStagesSupported) {
                        await client.reportMessageStatus(room.roomId, credential, request.eventId, 'working', {turnToken: token});
                    }
                },
                messageStatus: async (state, reason) => {
                    if (!reason.trim() || !snapshot.messageStagesSupported) {
                        throw new Error('A reason and a relay supporting message stages are required.');
                    }
                    await client.reportMessageStatus(room.roomId, credential, request.eventId, 'read');
                    database.prepare('UPDATE jobs SET acknowledged=1 WHERE event_id=?').run(request.eventId);
                    if (state === 'waiting') {
                        await client.reportMessageStatus(room.roomId, credential, request.eventId, state, {reason, ...(token ? {turnToken: token} : {})});
                    } else {
                        saveValue(`decision:${request.eventId}`, JSON.stringify({state, reason}));
                    }
                },
                pass: async () => {
                    if (!token) {
                        throw new Error('This relay does not support passing turns');
                    }
                    await client.acknowledgeMessage(room.roomId, credential, request.eventId);
                    database.prepare('UPDATE jobs SET acknowledged=1 WHERE event_id=?').run(request.eventId);
                    saveValue(`pass:${request.eventId}`, '1');
                },
                started: (turnId, processId) => {
                    database.prepare('UPDATE jobs SET turn_id=? WHERE event_id=?').run(turnId, request.eventId);
                    attemptJournal.runtimeStarted(attemptId, {providerThreadId: runtime!.threadId, turnId, ...(processId ? {processId} : {}), ...(attemptModel ? {model: attemptModel} : {})});
                },
                activity: (snapshot: ManagedDeadlineSnapshot) => {
                    lastDeadlineSnapshot = snapshot;
                    const now = Date.now();
                    if (now - lastJournalActivityWrite >= JOURNAL_ACTIVITY_INTERVAL_MS) {
                        lastJournalActivityWrite = now;
                        lastJournalActivityAt = snapshot.lastActivityAt;
                        attemptJournal.activity(attemptId, snapshot);
                    }
                    if (snapshot.lastActivityAt === snapshot.startedAt || now - lastStatusActivityWrite >= 1_000) {
                        lastStatusActivityWrite = now;
                        status({requestStartedAt: snapshot.startedAt, lastActivityAt: snapshot.lastActivityAt, idleDeadlineAt: snapshot.idleDeadlineAt, absoluteDeadlineAt: snapshot.absoluteDeadlineAt});
                    }
                },
                usage: (usage) => {
                    attemptJournal.usage(attemptId, usage);
                    status({usage});
                },
                model: (model) => {
                    const reported = modelId(model);
                    if (reported && reported !== attemptModel) {
                        attemptModel = reported;
                        saveValue('model', reported);
                        attemptJournal.model(attemptId, reported);
                        if (reported !== state.model) {
                            status({model: reported});
                        }
                    }
                }
            });
            if (config.runtime === 'qwen' && !database.prepare('SELECT acknowledged FROM jobs WHERE event_id=?').get(request.eventId)?.['acknowledged']) {
                if (runtime instanceof QwenReceiver) {
                    runtime.discardSession();
                }
                throw new Error('Qwen completed without confirming the request through its scoped tool; no final reply was published.');
            }
            if (leaseFailure) {
                throw leaseFailure;
            }
            // Persist before transmission; retries reuse the server's reply idempotency key.
            if (lastDeadlineSnapshot && lastDeadlineSnapshot.lastActivityAt !== lastJournalActivityAt) {
                attemptJournal.activity(attemptId, lastDeadlineSnapshot);
            }
            const completedPhase = savedValue(`decision:${request.eventId}`) ? 'decision' : savedValue(`pass:${request.eventId}`) === '1' ? 'pass' : 'reply';
            database.prepare('UPDATE jobs SET phase=?, answer=? WHERE event_id=?').run(completedPhase, answer, request.eventId);
            if (completedPhase === 'reply') {
                attemptJournal.answerSaved(attemptId);
            }
        } catch (error) {
            const reason = requestCancelled ? 'Request cancelled by its sender or a room admin; no answer was posted.' : error instanceof Error ? error.message : 'Runtime failed';
            // An interrupted turn is not a failure to report: the relay already fenced it.
            database.prepare('UPDATE jobs SET phase=?, failure=? WHERE event_id=?').run(requestCancelled ? 'cancelled' : error instanceof RuntimeInterrupted ? 'interrupted' : 'failed', reason, request.eventId);
            terminal = {kind: requestCancelled ? 'cancelled' : attemptTerminalKind(error), at: Date.now(), failureReason: reason, ...(lastDeadlineSnapshot ? {deadline: lastDeadlineSnapshot} : {})};
            // A failed or cancelled turn is not a proven provider checkpoint. The
            // next request starts a fresh conversation instead of resuming it.
            deleteValue('thread');
            runtime?.close();
            runtime = undefined;
            status({detail: reason});
        } finally {
            watching = false;
            clearInterval(heartbeat);
            await renewal;
            await interrupting?.catch((error: unknown) => status({detail: `Interrupt report failed: ${error instanceof Error ? error.message : String(error)}`}));
        }
        if (terminal) {
            if (terminal.kind === 'interrupted' || terminal.kind === 'cancelled') {
                terminal.cancellationGraceful = interruptOutcome === 'current_turn_cancelled' ? true : interruptOutcome === 'tool_cancellation_unknown' ? null : false;
            }
            attemptJournal.terminal(attemptId, terminal);
        }
        await flush();
        status({state: 'available', eventId: '', attempt: null, attemptId: null, requestStartedAt: null, lastActivityAt: null, idleDeadlineAt: null, absoluteDeadlineAt: null});
    }

    try {
        await client.snapshot(room.roomId, credential);
        receipts = startReceiptMonitor({serverUrl: room.serverUrl, roomId: room.roomId, participantId: session.participantId, credential, cursorPath: join(location.directory, 'receipt-cursor.json'), onError: (message) => {
            status({receiptError: message});
            if (message) {
                process.stderr.write(`PairLobby receipt retry: ${message}\n`);
            }
        }});
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
                // An interrupt that arrived between turns stopped nothing; say so once.
                if (member.paused && member.interruptRequested && (member.acknowledgedRevision ?? 0) < member.controlRevision) {
                    await acknowledgeControl(member.controlRevision, 'paused_between_turns').catch(() => {});
                }
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
        await receipts?.stop();
        clearInterval(timer);
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
        database.close();
        unlinkSync(location.lock);
    }
}

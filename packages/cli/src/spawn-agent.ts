import {execFile} from 'node:child_process';
import {accessSync, chmodSync, constants, existsSync, realpathSync, statSync} from 'node:fs';
import {delimiter, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import {PairLobbyClient} from '@pairlobby/client';
import type {LocalStore, SessionEntry} from '@pairlobby/client';
import {newCredential, newId, ProtocolError} from '@pairlobby/protocol';
import type {RoomSnapshot} from '@pairlobby/protocol';
import {select, UsageError} from './context.js';
import {accountToken, onlineOrigin} from './online.js';
import {receiverStatus, startReceiver, stopReceiver} from './receiver.js';
import type {ReceiverStatus} from './receiver.js';
import type {ReceiverRuntimeName} from './receiver-runtime.js';
import {parseSpawnOptions, SPAWN_HELP, splitCommand, validateEffort} from './spawn-options.js';
import type {SpawnOptions} from './spawn-options.js';
import {validateManagedDeadline} from './managed-deadline.js';
import {formatDuration} from './when.js';

const executeFile = promisify(execFile);
type SpawnPhase = 'minting' | 'redeeming' | 'joined' | 'ready' | 'cleanup' | 'failed';
type SpawnOperation = {
    id: string; roomId: string; actorSessionId: string; sessionId: string; participantCredential: string;
    runtime: ReceiverRuntimeName; name: string; model?: string; effort?: string; cwd: string; executable: string; idleTimeoutMs: number; absoluteTimeoutMs: number;
    phase: SpawnPhase; invite?: string; participantId?: string; joinedAt: number;
};
export type SpawnContext = {store: LocalStore; roomId: string; sessionId: string};
export type SpawnResult = {operationId: string; roomId: string; sessionId: string; participantId: string; name: string; runtime: string; model?: string; effort?: string; workdir: string; idleTimeoutMs: number; absoluteTimeoutMs: number; receiver: ReceiverStatus | null};
export type SpawnDependencies = {start?: typeof startReceiver; preflight?: typeof preflightRuntime};
type SpawnMetadata = {actorSessionId: string; invite?: string; model?: string};

/** Older spawned sessions already recorded their admission code in the private operation ledger. */
export function readSpawnMetadata(store: LocalStore, roomId: string): Map<string, SpawnMetadata> {
    const values = new Map<string, SpawnMetadata>();
    const file = join(store.directory, 'spawns.sqlite');
    if (!existsSync(file)) {
        return values;
    }
    const database = new DatabaseSync(file, {readOnly: true});
    try {
        const rows = database.prepare('SELECT payload FROM operations').all() as {payload: string}[];
        for (const row of rows) {
            const operation = JSON.parse(row.payload) as SpawnOperation;
            if (operation.roomId === roomId && operation.participantId) {
                values.set(operation.sessionId, {actorSessionId: operation.actorSessionId, ...(operation.invite ? {invite: operation.invite} : {}), ...(operation.model ? {model: operation.model} : {})});
            }
        }
        return values;
    } finally {
        database.close();
    }
}

function spawnClient(store: LocalStore, serverUrl: string): PairLobbyClient {
    return new PairLobbyClient(serverUrl, new URL(serverUrl).origin === onlineOrigin() ? accountToken(store) : undefined);
}

function actorSnapshot(snapshot: RoomSnapshot, participantId: string): void {
    const actor = snapshot.participants.find((participant) => participant.participantId === participantId);
    if (!actor || actor.kind !== 'human' || actor.role === 'guest' || actor.left || actor.revoked || actor.muted) {
        throw new UsageError('Spawning and local agent controls require an active, unmuted human member.');
    }
}

export async function preflightRuntime(runtime: ReceiverRuntimeName, cwd: string, effort?: string): Promise<string> {
    let executable: string | undefined;
    for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
        const candidate = resolve(directory || process.cwd(), runtime);
        try {
            accessSync(candidate, constants.X_OK);
            if (statSync(candidate).isFile()) {
                executable = realpathSync(candidate);
                break;
            }
        } catch {
            // Try the next PATH entry; never install or change authentication implicitly.
        }
    }
    if (!executable) {
        throw new UsageError(`${runtime} is not installed on PATH. Install and sign in to its CLI, then retry.`);
    }
    if (effort) {
        validateEffort(runtime, effort);
        if (runtime === 'claude') {
            const environment = {...process.env};
            delete environment['CLAUDECODE'];
            const {stdout} = await executeFile(executable, ['--help'], {cwd, env: environment, timeout: 8000, maxBuffer: 1024 * 1024});
            const description = stdout.match(/--effort\b[\s\S]*?(?=\n\s+--|$)/)?.[0];
            if (!description || !new RegExp(`\\b${effort}\\b`).test(description)) {
                throw new UsageError(`Installed Claude does not advertise --effort ${effort}. Update it or omit --effort.`);
            }
        }
    }
    return executable;
}

function operationDatabase(store: LocalStore): DatabaseSync {
    const file = join(store.directory, 'spawns.sqlite');
    const db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS spawn_lock(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL);`);
    return db;
}

async function acquire(db: DatabaseSync, token: string): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt++) {
        if (db.prepare('INSERT OR IGNORE INTO spawn_lock VALUES(1,?,?)').run(process.pid, token).changes) {
            return;
        }
        const owner = db.prepare('SELECT pid, token FROM spawn_lock WHERE id=1').get() as {pid: number; token: string} | undefined;
        if (owner) {
            try {
                process.kill(owner.pid, 0);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                    db.prepare('DELETE FROM spawn_lock WHERE token=?').run(owner.token);
                }
            }
        }
        await sleep(50);
    }
    throw new UsageError('Another local agent operation is still running. Retry when it finishes.');
}

function save(db: DatabaseSync, operation: SpawnOperation): void {
    db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?)').run(operation.id, JSON.stringify(operation));
}

function load(db: DatabaseSync, id: string): SpawnOperation | undefined {
    const row = db.prepare('SELECT payload FROM operations WHERE id=?').get(id) as {payload: string} | undefined;
    return row ? JSON.parse(row.payload) as SpawnOperation : undefined;
}

function result(store: LocalStore, operation: SpawnOperation): SpawnResult {
    return {operationId: operation.id, roomId: operation.roomId, sessionId: operation.sessionId, participantId: operation.participantId!, name: operation.name, runtime: operation.runtime, ...(operation.model ? {model: operation.model} : {}), ...(operation.effort ? {effort: operation.effort} : {}), workdir: operation.cwd, idleTimeoutMs: operation.idleTimeoutMs, absoluteTimeoutMs: operation.absoluteTimeoutMs, receiver: receiverStatus(store, operation.sessionId)};
}

async function cleanup(client: PairLobbyClient, store: LocalStore, operation: SpawnOperation): Promise<void> {
    await stopReceiver(store, operation.sessionId);
    try {
        await client.leave(operation.roomId, operation.participantCredential);
    } catch (error) {
        if (!(error instanceof ProtocolError) || !['participant_revoked', 'room_closed', 'room_expired', 'room_not_found'].includes(error.code)) {
            throw error;
        }
    }
}

/** Ordinary local orchestration; neither admission nor startup sends a model prompt. */
export async function spawnAgent(context: SpawnContext, options: SpawnOptions, dependencies: SpawnDependencies = {}): Promise<SpawnResult> {
    const {store, roomId, sessionId} = context;
    const actor = select(store, roomId, sessionId);
    const client = spawnClient(store, actor.room.serverUrl);
    const db = operationDatabase(store);
    const lock = newId('attempt');
    let operation: SpawnOperation | undefined;
    try {
        await acquire(db, lock);
        const snapshot = await client.snapshot(roomId, actor.credential);
        actorSnapshot(snapshot, actor.session.participantId);
        if (options.resume) {
            operation = load(db, options.resume);
            if (!operation || operation.roomId !== roomId || operation.actorSessionId !== sessionId) {
                throw new UsageError('No spawn operation with that ID belongs to this human session and room.');
            }
            operation.idleTimeoutMs ??= store.settings().managedTaskIdleMs;
            operation.absoluteTimeoutMs ??= store.settings().managedTaskTimeoutMs;
            if (operation.phase === 'ready') {
                return result(store, operation);
            }
            if (operation.phase === 'failed') {
                throw new UsageError('This spawn was rolled back. Run a new spawn command to try again.');
            }
            if (operation.phase === 'cleanup') {
                await cleanup(client, store, operation);
                operation.phase = 'failed';
                save(db, operation);
                throw new UsageError('Spawn cleanup completed. Run a new spawn command to try again.');
            }
        } else {
            if (snapshot.locked) {
                throw new UsageError('This room is locked. Unlock it before spawning a new agent.');
            }
            const runtime = options.runtime;
            if (!runtime) {
                throw new UsageError('A spawn runtime is required');
            }
            const cwd = realpathSync(resolve(options.workdir ?? process.cwd()));
            if (!statSync(cwd).isDirectory()) {
                throw new UsageError('Workdir must be an existing directory');
            }
            const executable = await (dependencies.preflight ?? preflightRuntime)(runtime, cwd, options.effort);
            const reserved = (db.prepare('SELECT payload FROM operations').all() as {payload: string}[]).map((row) => JSON.parse(row.payload) as SpawnOperation).filter((entry) => entry.roomId === roomId && !['ready', 'failed'].includes(entry.phase));
            const names = new Set([...snapshot.participants.filter((member) => !member.left && !member.revoked).map((member) => member.displayName.toLowerCase()), ...reserved.map((entry) => entry.name.toLowerCase())]);
            let name = options.name ?? runtime;
            if (options.name && names.has(name.toLowerCase())) {
                throw new UsageError(`An active or starting participant is already named ${name}. Choose --name explicitly.`);
            }
            for (let suffix = 2; names.has(name.toLowerCase()); suffix++) {
                name = `${runtime}-${suffix}`;
            }
            const settings = store.settings();
            const deadline = validateManagedDeadline({idleMs: options.taskIdleTimeoutMs ?? settings.managedTaskIdleMs, absoluteMs: options.taskTimeoutMs ?? settings.managedTaskTimeoutMs});
            operation = {id: newId('attempt'), roomId, actorSessionId: sessionId, sessionId: newId('session'), participantCredential: newCredential('participant'), runtime, name, cwd, executable, idleTimeoutMs: deadline.idleMs, absoluteTimeoutMs: deadline.absoluteMs, ...(options.model ? {model: options.model} : {}), ...(options.effort ? {effort: options.effort} : {}), phase: 'minting', joinedAt: Date.now()};
            save(db, operation);
        }
        if (operation.phase === 'minting') {
            // A lost mint response cannot have created a membership. Its unused invite expires shortly.
            const invite = await client.mintInvite(roomId, actor.credential, 'member', false, Date.now() + 300_000);
            operation.invite = invite.code;
            operation.phase = 'redeeming';
            save(db, operation);
        }
        if (operation.phase === 'redeeming') {
            const identity = {displayName: operation.name, kind: 'agent' as const, sessionId: operation.sessionId, capabilities: {runtime: operation.runtime, deliverUnsolicited: true, cancelTurn: false, cancelTool: false}};
            const joined = await client.redeemInvite(operation.invite!, identity, {attemptId: operation.id, participantCredential: operation.participantCredential}, false);
            operation.participantId = joined.participantId;
            operation.phase = 'joined';
            save(db, operation);
        }
        try {
            const current = await client.snapshot(roomId, operation.participantCredential);
            const participant = current.participants.find((entry) => entry.participantId === operation!.participantId);
            if (!participant || participant.left || participant.revoked || participant.muted) {
                throw new UsageError('The newly joined agent is no longer active.');
            }
            const existing = store.room(roomId)?.sessions.find((entry) => entry.sessionId === operation!.sessionId);
            store.putCredential(roomId, operation.sessionId, operation.participantCredential);
            if (operation.invite) {
                store.putSessionInvite(roomId, operation.sessionId, operation.invite);
            }
            const entry: SessionEntry = {participantId: operation.participantId!, sessionId: operation.sessionId, displayName: participant.displayName, kind: 'agent', role: 'member', runtime: operation.runtime, joinedAt: operation.joinedAt, lastReadSeq: 0, cwd: operation.cwd, spawnedBy: sessionId, ...(operation.model ? {model: operation.model} : {}), ...(operation.effort ? {effort: operation.effort} : {})};
            if (!existing) {
                store.addSession(roomId, entry);
            }
            await (dependencies.start ?? startReceiver)(store, roomId, operation.sessionId, {workdir: operation.cwd, executable: operation.executable, idleTimeoutMs: operation.idleTimeoutMs, absoluteTimeoutMs: operation.absoluteTimeoutMs, ...(operation.model ? {model: operation.model} : {}), ...(operation.effort ? {effort: operation.effort} : {})});
            operation.phase = 'ready';
            save(db, operation);
            return result(store, operation);
        } catch (error) {
            operation.phase = 'cleanup';
            save(db, operation);
            await cleanup(client, store, operation);
            operation.phase = 'failed';
            save(db, operation);
            throw error;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Spawn failed';
        if (operation && operation.phase !== 'ready' && operation.phase !== 'failed') {
            throw new UsageError(`${message}\nSpawn operation ${operation.id} needs recovery. Use /spawn --resume ${operation.id} in this room (CLI: pairlobby spawn --resume ${operation.id} --room ${roomId} --session ${sessionId}).`);
        }
        throw error;
    } finally {
        db.prepare('DELETE FROM spawn_lock WHERE token=?').run(lock);
        db.close();
        client.closeLive();
    }
}

export function formatSpawnResult(value: SpawnResult): string {
    return `${value.name} joined · ${value.runtime} · receiver ${value.receiver?.state ?? 'not configured'}\nModel: ${value.model ?? 'provider default'}${value.effort ? ` · effort: ${value.effort}` : ''}\nManaged request limits: inactivity ${formatDuration(value.idleTimeoutMs)} · absolute ${formatDuration(value.absoluteTimeoutMs)}\nSession: ${value.sessionId}\nReceiver readiness does not verify provider access; send @${value.name} a task to start work.`;
}

export async function runAgentCommand(line: string, context: SpawnContext): Promise<string> {
    const [command, ...args] = splitCommand(line);
    if (command === '/agents') {
        if (args.length) {
            throw new UsageError('Usage: /agents');
        }
        const {loadAgentRoster, formatAgentRoster} = await import('./agent-roster.js');
        return formatAgentRoster(await loadAgentRoster(context));
    }
    if (command === '/agent') {
        return manageAgent(context, args);
    }
    const options = parseSpawnOptions(command === '/spawn' ? args : [command!.slice(1), ...args]);
    return options.help ? SPAWN_HELP : formatSpawnResult(await spawnAgent(context, options));
}

async function manageAgent(context: SpawnContext, args: string[]): Promise<string> {
    const {store, roomId, sessionId} = context;
    const actor = select(store, roomId, sessionId);
    const snapshot = await actor.client.snapshot(roomId, actor.credential);
    actorSnapshot(snapshot, actor.session.participantId);
    const agents = actor.room.sessions.filter((entry) => entry.spawnedBy === sessionId && snapshot.participants.some((member) => member.participantId === entry.participantId && !member.left && !member.revoked));
    const [action, reference] = args;
    if (!['start', 'stop'].includes(action ?? '') || args.length !== 2) {
        throw new UsageError('Usage: /agents or /agent start|stop <name or participant ID>');
    }
    const matches = agents.filter((agent) => agent.participantId === reference || agent.sessionId === reference || snapshot.participants.find((member) => member.participantId === agent.participantId)?.displayName.toLowerCase() === reference!.replace(/^@/, '').toLowerCase());
    if (matches.length !== 1) {
        throw new UsageError('Choose one unambiguous agent spawned by this human session; use /agents for IDs.');
    }
    const agent = matches[0]!;
    if (action === 'stop') {
        await stopReceiver(store, agent.sessionId);
        return `${agent.displayName}: receiver stopped; still joined. Requests may queue. Tool-descendant cancellation is not verified.`;
    }
    const status = await startReceiver(store, roomId, agent.sessionId);
    return `${agent.displayName}: receiver ${status.state}`;
}

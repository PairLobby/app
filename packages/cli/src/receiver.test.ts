import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';

type Joined = {roomId: string; sessionId: string; participantId: string; receiver: {pid: number; state: string; idleTimeoutMs: number; absoluteTimeoutMs: number}};

test.each(['codex', 'claude', 'qwen'])('%s CLI joins receive asynchronously and recover without repeating uncertain work', async (runtime) => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-receiver-'));
    const record = join(directory, 'calls.txt');
    const executable = join(directory, runtime);
    copyFileSync(resolve(`scripts/fixtures/${runtime}-receiver.mjs`), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('receiver test', {displayName: runtime === 'codex' ? 'claude' : 'codex', kind: 'agent'});
    const environment = {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_TEST_RECORD: record};
    const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');
    let joined: Joined | undefined;

    async function command(args: string[]): Promise<any> {
        return new Promise((done, reject) => {
            const child = spawn(process.execPath, [cli, ...args], {env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
            let output = '', errors = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errors += chunk; });
            child.on('error', reject);
            child.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(errors));
                } else {
                    done(JSON.parse(output));
                }
            });
        });
    }

    async function waitFor(check: () => Promise<boolean>): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (await check()) {
                return;
            }
            await sleep(100);
        }
        throw new Error('Receiver assertion timed out');
    }

    const calls = () => existsSync(record) ? readFileSync(record, 'utf8').split('\n') : [];
    try {
        joined = await command(['join', host.invite.code, '--server', relay.url, '--runtime', runtime, '--as', runtime, '--workdir', directory, '--model', 'fixture-model', '--task-idle-timeout', '12m', '--task-timeout', '2h', '--json']) as Joined;
        expect(joined.receiver.state).toBe('available');
        expect(joined.receiver).toMatchObject({idleTimeoutMs: 720_000, absoluteTimeoutMs: 7_200_000});
        const scope = ['--room', joined.roomId, '--session', joined.sessionId];
        await expect(command(['channel', ...scope, '--allow-from', host.participantId])).rejects.toThrow('managed receiver already owns');
        await sleep(1200);
        expect(calls()).toEqual([]);
        await client.setMuted(host.roomId, host.controllerCredential, joined.participantId, true);
        const request = {type: 'message' as const, recipientId: joined.participantId, payload: {text: 'Please answer', priority: 'normal' as const}, idempotencyKey: 'first'};
        const sent = await client.send(host.roomId, host.participantCredential, request);
        await sleep(1200);
        expect(calls()).toEqual([]);
        await waitFor(async () => (await client.request(host.roomId, host.participantCredential, sent.event.eventId)).receivedAt !== null);
        expect((await client.request(host.roomId, host.participantCredential, sent.event.eventId)).readAt).toBeUndefined();
        await client.setMuted(host.roomId, host.controllerCredential, joined.participantId, false);
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, sent.event.eventId)).responseEventId));
        expect((await client.request(host.roomId, host.participantCredential, sent.event.eventId)).receivedAt).not.toBeNull();
        expect((await client.request(host.roomId, host.participantCredential, sent.event.eventId)).readAt).toBeTypeOf('number');
        const reportedModel = runtime === 'claude' ? 'claude-opus-5-5' : runtime === 'qwen' ? 'qwen3-coder-plus' : 'fixture-model';
        expect((await command(['receiver', 'status', ...scope])).model).toBe(reportedModel);
        await client.send(host.roomId, host.participantCredential, request);
        const broadcast = await client.send(host.roomId, host.participantCredential, {type: 'message', payload: {text: 'Broadcast', priority: 'normal'}, idempotencyKey: 'broadcast'});
        await waitFor(async () => (await client.readEvents(host.roomId, host.participantCredential, 0)).events.some((event) => event.type === 'message.received' && event.senderId === joined!.participantId && event.payload.eventId === broadcast.event.eventId));
        await sleep(1200);
        expect(calls().filter((line) => line === 'turn/start')).toHaveLength(1);
        expect(calls()).toContain(runtime === 'codex' ? 'approval:decline' : 'ack:confirmed');
        if (runtime !== 'codex') {
            expect(calls()).toContain('process/exit');
        }

        await command(['receiver', 'stop', ...scope]);
        const second = await client.send(host.roomId, host.participantCredential, {...request, idempotencyKey: 'second'});
        await sleep(200);
        expect((await client.request(host.roomId, host.participantCredential, second.event.eventId)).receivedAt).toBeNull();
        await command(['receiver', 'start', ...scope]);
        expect((await command(['receiver', 'status', ...scope])).model).toBe(reportedModel);
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, second.event.eventId)).responseEventId));
        expect(calls()).toContain('thread/resume');
        expect(calls().filter((line) => line === 'turn/start')).toHaveLength(2);

        const uncertain = await client.send(host.roomId, host.participantCredential, {...request, payload: {text: 'hang-until-crash', priority: 'normal'}, idempotencyKey: 'uncertain'});
        await waitFor(async () => calls().filter((line) => line === 'turn/start').length === 3);
        // A long-running provider turn must not block receipt of other traffic.
        const duringWork = await client.send(host.roomId, host.participantCredential, {type: 'message', payload: {text: 'Notice during work', priority: 'normal'}, idempotencyKey: 'during-work'});
        await waitFor(async () => (await client.readEvents(host.roomId, host.participantCredential, 0)).events.some((event) => event.type === 'message.received' && event.senderId === joined!.participantId && event.payload.eventId === duringWork.event.eventId));
        const status = await command(['receiver', 'status', ...scope]);
        process.kill(status.pid, 'SIGKILL');
        await sleep(300);
        await command(['receiver', 'start', ...scope]);
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, uncertain.event.eventId)).failureAt));
        expect(calls().filter((line) => line === 'turn/start')).toHaveLength(3);
        const failure = await client.request(host.roomId, host.participantCredential, uncertain.event.eventId);
        expect(failure.receivedAt).not.toBeNull();
        expect(failure.failureReason).toContain('uncertain');
        if (runtime !== 'codex') {
            const next = await client.send(host.roomId, host.participantCredential, {...request, idempotencyKey: 'after-crash'});
            await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, next.event.eventId)).responseEventId));
            expect(calls().filter((line) => line === 'thread/start')).toHaveLength(2);
            const invalid = await client.send(host.roomId, host.participantCredential, {...request, idempotencyKey: 'invalid-ack', payload: {text: 'invalid-ack', priority: 'normal'}});
            await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, invalid.event.eventId)).failureAt));
            await waitFor(async () => (await client.request(host.roomId, host.participantCredential, invalid.event.eventId)).receivedAt !== null);
            expect(calls()).toContain('ack:rejected');
        }
        if (runtime === 'qwen') {
            expect(calls()).toContain('approval:decline');
            const missing = await client.send(host.roomId, host.participantCredential, {...request, idempotencyKey: 'no-ack', payload: {text: 'no-ack', priority: 'normal'}});
            await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, missing.event.eventId)).failureAt));
            const outcome = await client.request(host.roomId, host.participantCredential, missing.event.eventId);
            await waitFor(async () => (await client.request(host.roomId, host.participantCredential, missing.event.eventId)).receivedAt !== null);
            expect(outcome.responseEventId).toBeNull();
            const state = JSON.parse(readFileSync(join(environment.PAIRLOBBY_DATA_DIR, 'receivers', joined.sessionId, 'qwen-session.json'), 'utf8'));
            expect(state.completed).toBe(false);
        }
        const decision = await client.send(host.roomId, host.participantCredential, {...request, idempotencyKey: 'decision', payload: {text: 'no-action-fixture', priority: 'normal'}});
        await waitFor(async () => (await client.request(host.roomId, host.participantCredential, decision.event.eventId)).action === 'no_action');
        expect(await client.request(host.roomId, host.participantCredential, decision.event.eventId)).toMatchObject({requiresReply: false, responseEventId: null, readAt: expect.any(Number), actionReason: 'No further work needed'});
    } finally {
        if (joined) {
            await command(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]);
        }
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 40_000);

test.each(['codex', 'claude', 'qwen'])('%s receiver reports an inactivity timeout without retrying the request', async (runtime) => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-receiver-deadline-'));
    const executable = join(directory, runtime);
    copyFileSync(resolve(`scripts/fixtures/${runtime}-receiver.mjs`), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('receiver deadline', {displayName: 'owner', kind: 'human'});
    const environment = {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_TEST_RECORD: join(directory, 'calls.txt'), PAIRLOBBY_TEST_DELAY_MS: '1500'};
    const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');
    let joined: Joined | undefined;

    async function command(args: string[]): Promise<any> {
        return new Promise((done, reject) => {
            const child = spawn(process.execPath, [cli, ...args], {env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
            let output = '', errors = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errors += chunk; });
            child.on('error', reject);
            child.on('exit', (code) => code === 0 ? done(JSON.parse(output)) : reject(new Error(errors)));
        });
    }

    async function waitForFailure(eventId: string): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt++) {
            if ((await client.request(host.roomId, host.participantCredential, eventId)).failureAt) {
                return;
            }
            await sleep(100);
        }
        throw new Error('receiver inactivity timeout was not reported');
    }

    try {
        joined = await command(['join', host.invite.code, '--server', relay.url, '--runtime', runtime, '--as', runtime, '--workdir', directory, '--model', 'fixture-model', '--task-idle-timeout', '1s', '--task-timeout', '5s', '--json']) as Joined;
        const sent = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'Please answer after the fixture delay', priority: 'normal'}, idempotencyKey: newId('event')});
        let working: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 10; attempt++) {
            working = await command(['receiver', 'status', '--room', joined.roomId, '--session', joined.sessionId]);
            if (working['state'] === 'working' && typeof working['lastActivityAt'] === 'number') {
                break;
            }
            await sleep(50);
        }
        expect(working).toMatchObject({state: 'working', idleTimeoutMs: 1_000, absoluteTimeoutMs: 5_000, requestStartedAt: expect.any(Number), lastActivityAt: expect.any(Number), idleDeadlineAt: expect.any(Number), absoluteDeadlineAt: expect.any(Number)});
        await waitForFailure(sent.event.eventId);
        const failed = await client.request(host.roomId, host.participantCredential, sent.event.eventId);
        expect(failed.failureReason).toContain('no runtime activity for 1 second');
        const status = await command(['receiver', 'status', '--room', joined.roomId, '--session', joined.sessionId]);
        expect(status).toMatchObject({state: 'available', idleTimeoutMs: 1_000, absoluteTimeoutMs: 5_000, requestStartedAt: null, lastActivityAt: null, idleDeadlineAt: null, absoluteDeadlineAt: null});
    } finally {
        if (joined) {
            await command(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]);
        }
        client.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 30_000);

type DeadlineOutcome = {failureReason?: string | null | undefined; responseEventId?: string | null | undefined};

/** One managed request against a fixture runtime that stays busy (output every `heartbeatMs`) for `delayMs` before answering. */
async function busyRequest(runtime: string, limits: {idle: string; absolute: string}, delayMs: number, heartbeatMs: number): Promise<DeadlineOutcome> {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-receiver-busy-'));
    const executable = join(directory, runtime);
    copyFileSync(resolve(`scripts/fixtures/${runtime}-receiver.mjs`), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('receiver busy', {displayName: 'owner', kind: 'human'});
    const environment = {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_TEST_RECORD: join(directory, 'calls.txt'), PAIRLOBBY_TEST_DELAY_MS: String(delayMs), PAIRLOBBY_TEST_HEARTBEAT_MS: String(heartbeatMs)};
    const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');
    let joined: Joined | undefined;

    async function command(args: string[]): Promise<any> {
        return new Promise((done, reject) => {
            const child = spawn(process.execPath, [cli, ...args], {env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
            let output = '', errors = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errors += chunk; });
            child.on('error', reject);
            child.on('exit', (code) => code === 0 ? done(JSON.parse(output)) : reject(new Error(errors)));
        });
    }

    try {
        joined = await command(['join', host.invite.code, '--server', relay.url, '--runtime', runtime, '--as', runtime, '--workdir', directory, '--model', 'fixture-model', '--task-idle-timeout', limits.idle, '--task-timeout', limits.absolute, '--json']) as Joined;
        const sent = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'Please answer after staying busy', priority: 'normal'}, idempotencyKey: newId('event')});
        for (let attempt = 0; attempt < 150; attempt++) {
            const request = await client.request(host.roomId, host.participantCredential, sent.event.eventId);
            if (request.failureAt || request.responseEventId) {
                return {failureReason: request.failureReason, responseEventId: request.responseEventId};
            }
            await sleep(100);
        }
        throw new Error('the busy request neither answered nor failed');
    } finally {
        if (joined) {
            await command(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]);
        }
        client.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}

test.each(['codex', 'claude', 'qwen'])('%s output keeps a request alive well past the inactivity limit', async (runtime) => {
    // Busy for three inactivity limits; the old wall-clock deadline would have stopped it at one.
    const outcome = await busyRequest(runtime, {idle: '1s', absolute: '20s'}, 3_000, 250);
    expect(outcome.failureReason ?? null).toBeNull();
    expect(outcome.responseEventId).toMatch(/^ev_/);
}, 40_000);

test.each(['codex', 'claude', 'qwen'])('%s output never extends the absolute limit', async (runtime) => {
    // Keep enough separation that parallel test load cannot make a 250 ms fixture heartbeat
    // race the inactivity timer; this case is about the independent absolute ceiling.
    const outcome = await busyRequest(runtime, {idle: '3s', absolute: '4s'}, 8_000, 250);
    expect(outcome.failureReason).toContain('exceeded the 4 seconds absolute request limit');
    expect(outcome.responseEventId ?? null).toBeNull();
}, 40_000);

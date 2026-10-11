import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';

type Joined = {roomId: string; sessionId: string; participantId: string; receiver: {pid: number; state: string}};
type AttemptSummary = {attemptId: string; ordinal: number; recoverySourceAttemptId?: string; terminal?: {kind: string; providerWait?: {provider: string}}};
type AttemptsResponse = {attempts: AttemptSummary[]};
type RetryProviderResponse = {scheduled: string[]};

function currentTorontoResetText(): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit', hour12: true}).formatToParts(new Date()).map((part) => [part.type, part.value]));
    return `You've hit your session limit · resets ${parts['hour']}:${parts['minute']}${parts['dayPeriod']!.toLowerCase()} (America/Toronto)`;
}

test('Claude usage exhaustion defers once, fences its queue, and safely retries the same request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-provider-wait-'));
    const record = join(directory, 'calls.txt');
    const marker = join(directory, 'usage-limit-reported');
    const executable = join(directory, 'claude');
    copyFileSync(resolve('scripts/fixtures/claude-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('provider wait', {displayName: 'owner', kind: 'human'});
    const environment = {
        ...process.env,
        PATH: `${directory}:${process.env['PATH']}`,
        PAIRLOBBY_DATA_DIR: join(directory, 'device'),
        PAIRLOBBY_TEST_RECORD: record,
        PAIRLOBBY_TEST_USAGE_LIMIT_ONCE: marker
    };
    const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');
    let joined: Joined | undefined;
    let debugRequestId: string | undefined;

    async function command<T = unknown>(args: string[]): Promise<T> {
        return new Promise((done, reject) => {
            const child = spawn(process.execPath, [cli, ...args], {env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
            let output = '';
            let errors = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errors += chunk; });
            child.on('error', reject);
            child.on('exit', (code) => code === 0 ? done(JSON.parse(output) as T) : reject(new Error(errors)));
        });
    }

    async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
        for (let attempt = 0; attempt < 150; attempt++) {
            if (await check()) {
                return;
            }
            await sleep(100);
        }
        const status = joined ? await command(['receiver', 'status', '--room', joined.roomId, '--session', joined.sessionId]) : null;
        const log = joined ? readFileSync(join(environment.PAIRLOBBY_DATA_DIR, 'receivers', joined.sessionId, 'receiver.log'), 'utf8') : '';
        const request = debugRequestId ? await client.request(host.roomId, host.participantCredential, debugRequestId) : null;
        const inbox = joined ? new DatabaseSync(join(environment.PAIRLOBBY_DATA_DIR, 'receivers', joined.sessionId, 'inbox.sqlite'), {readOnly: true}) : null;
        const jobs = inbox?.prepare('SELECT * FROM jobs').all() ?? [];
        inbox?.close();
        throw new Error(`${message}: ${JSON.stringify({status, request, jobs, calls: calls(), log})}`);
    }

    const calls = () => existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
    try {
        joined = await command<Joined>(['join', host.invite.code, '--server', relay.url, '--runtime', 'claude', '--as', 'claude', '--workdir', directory, '--model', 'fixture-model', '--json']);
        const first = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'usage-limit-fixture: finish the task safely', priority: 'normal'}, idempotencyKey: newId('event')});
        debugRequestId = first.event.eventId;
        const second = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'queued behind provider wait', priority: 'normal'}, idempotencyKey: newId('event')});

        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, first.event.eventId)).providerWait), 'request never entered provider wait');
        const deferred = await client.request(host.roomId, host.participantCredential, first.event.eventId);
        expect(deferred).toMatchObject({requiresReply: true, responseEventId: null, action: 'provider_wait', providerWait: {provider: 'claude', model: 'claude-opus-5-5', limitKind: 'session', resetTimezone: 'America/Toronto', automaticRetry: true, resetActionUrl: 'https://clau.de/reset', source: 'result'}});
        expect(deferred.failureAt).toBeFalsy();
        expect((await command(['receiver', 'status', '--room', joined.roomId, '--session', joined.sessionId]))).toMatchObject({state: 'provider_wait', providerWait: {provider: 'claude'}});
        expect((await client.turnQueue(host.roomId, host.participantCredential)).entries.find((entry) => entry.requestId === first.event.eventId)?.state).toBe('provider_wait');
        await sleep(500);
        expect(calls().filter((line) => line === 'turn/start')).toHaveLength(1);
        expect((await client.request(host.roomId, host.participantCredential, second.event.eventId)).responseEventId).toBeNull();

        const before = await command<AttemptsResponse>(['receiver', 'attempts', '--room', joined.roomId, '--session', joined.sessionId, '--request', first.event.eventId]);
        expect(before.attempts).toHaveLength(1);
        expect(before.attempts[0]).toMatchObject({ordinal: 1, terminal: {kind: 'usage_limited', providerWait: {provider: 'claude'}}});

        const retried = await command<RetryProviderResponse>(['request', 'retry-provider', first.event.eventId, '--room', joined.roomId, '--session', joined.sessionId, '--json']);
        expect(retried.scheduled).toEqual([first.event.eventId]);
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, first.event.eventId)).responseEventId), 'provider retry did not answer the original request');
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, second.event.eventId)).responseEventId), 'queued request did not continue after recovery');
        const completed = await client.request(host.roomId, host.participantCredential, first.event.eventId);
        expect(completed.attempt).toBe(2);
        expect(completed.providerWait).toBeUndefined();
        expect(completed.failureAt).toBeFalsy();
        expect(completed.responseText).toContain('Provider recovery attempt 2');
        expect(calls().filter((line) => line === 'turn/start')).toHaveLength(3);

        const after = await command<AttemptsResponse>(['receiver', 'attempts', '--room', joined.roomId, '--session', joined.sessionId, '--request', first.event.eventId]);
        expect(after.attempts).toHaveLength(2);
        expect(after.attempts.map((attempt) => attempt.terminal?.kind)).toEqual(['usage_limited', 'answered']);
        expect(after.attempts[1]!.recoverySourceAttemptId).toBe(after.attempts[0]!.attemptId);
        const failures = (await client.readEvents(host.roomId, host.participantCredential, 0)).events.filter((event) => event.type === 'message.delivery_failed' && event.payload.eventId === first.event.eventId);
        expect(failures).toEqual([]);
    } finally {
        if (joined) {
            await command(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]);
        }
        client.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 30_000);

test('a receiver restart restores a due cooldown and automatically creates one recovery attempt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-provider-auto-'));
    const record = join(directory, 'calls.txt');
    const executable = join(directory, 'claude');
    copyFileSync(resolve('scripts/fixtures/claude-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('provider automatic retry', {displayName: 'owner', kind: 'human'});
    const environment = {
        ...process.env,
        PATH: `${directory}:${process.env['PATH']}`,
        PAIRLOBBY_DATA_DIR: join(directory, 'device'),
        PAIRLOBBY_TEST_RECORD: record,
        PAIRLOBBY_TEST_USAGE_LIMIT_ONCE: join(directory, 'usage-limit-reported'),
        PAIRLOBBY_TEST_USAGE_LIMIT_COUNT: '2',
        PAIRLOBBY_TEST_USAGE_LIMIT_TEXT: currentTorontoResetText(),
        PAIRLOBBY_TEST_PROVIDER_BACKOFF_MS: '1000',
        PAIRLOBBY_TEST_PROVIDER_GRACE_MS: '60000'
    };
    const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');
    let joined: Joined | undefined;

    async function command<T = unknown>(args: string[]): Promise<T> {
        return new Promise((done, reject) => {
            const child = spawn(process.execPath, [cli, ...args], {env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
            let output = '';
            let errors = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errors += chunk; });
            child.on('error', reject);
            child.on('exit', (code) => code === 0 ? done(JSON.parse(output) as T) : reject(new Error(errors)));
        });
    }

    try {
        joined = await command<Joined>(['join', host.invite.code, '--server', relay.url, '--runtime', 'claude', '--as', 'claude', '--workdir', directory, '--model', 'fixture-model', '--json']);
        const sent = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'usage-limit-fixture: recover automatically', priority: 'normal'}, idempotencyKey: newId('event')});
        for (let attempt = 0; attempt < 100; attempt++) {
            if ((await client.request(host.roomId, host.participantCredential, sent.event.eventId)).providerWait) {
                break;
            }
            await sleep(100);
        }
        expect((await client.request(host.roomId, host.participantCredential, sent.event.eventId)).providerWait).toBeTruthy();
        await command(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]);
        const cooldownDatabase = new DatabaseSync(join(environment.PAIRLOBBY_DATA_DIR, 'provider-cooldowns.sqlite'));
        const row = cooldownDatabase.prepare('SELECT profile_key, body FROM provider_cooldowns').get() as {profile_key: string; body: string};
        const cooldown = JSON.parse(row.body) as {wakeAt: number | null; automaticRetry: boolean};
        cooldown.wakeAt = Date.now() - 10_000;
        cooldown.automaticRetry = true;
        cooldownDatabase.prepare('UPDATE provider_cooldowns SET body=? WHERE profile_key=?').run(JSON.stringify(cooldown), row.profile_key);
        cooldownDatabase.close();
        await command(['receiver', 'start', '--room', joined.roomId, '--session', joined.sessionId]);
        for (let attempt = 0; attempt < 100; attempt++) {
            const request = await client.request(host.roomId, host.participantCredential, sent.event.eventId);
            if (request.attempt === 2 && request.providerWait) {
                break;
            }
            await sleep(100);
        }
        const backedOff = await client.request(host.roomId, host.participantCredential, sent.event.eventId);
        expect(backedOff).toMatchObject({attempt: 2, providerWait: {automaticRetry: true, displayMessage: expect.stringContaining('bounded backoff')}});
        await sleep(400);
        expect(readFileSync(record, 'utf8').split('\n').filter((line) => line === 'turn/start')).toHaveLength(2);
        let completed = false;
        for (let attempt = 0; attempt < 200; attempt++) {
            if ((await client.request(host.roomId, host.participantCredential, sent.event.eventId)).responseEventId) {
                completed = true;
                break;
            }
            await sleep(100);
        }
        expect(completed).toBe(true);
        const request = await client.request(host.roomId, host.participantCredential, sent.event.eventId);
        expect(request).toMatchObject({attempt: 3, responseEventId: expect.stringMatching(/^ev_/)});
        expect(request.failureAt).toBeFalsy();
        expect(request.providerWait).toBeUndefined();
        const attempts = await command<AttemptsResponse>(['receiver', 'attempts', '--room', joined.roomId, '--session', joined.sessionId, '--request', sent.event.eventId]);
        expect(attempts.attempts.map((attempt) => attempt.terminal?.kind)).toEqual(['usage_limited', 'usage_limited', 'answered']);
        expect(readFileSync(record, 'utf8').split('\n').filter((line) => line === 'turn/start')).toHaveLength(3);
    } finally {
        if (joined) {
            await command(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]);
        }
        client.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 30_000);

test('two Claude receivers sharing one profile fence together and only the targeted receiver probes capacity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-provider-shared-'));
    const record = join(directory, 'calls.txt');
    const executable = join(directory, 'claude');
    copyFileSync(resolve('scripts/fixtures/claude-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('shared provider cooldown', {displayName: 'owner', kind: 'human'});
    const environment = {
        ...process.env,
        PATH: `${directory}:${process.env['PATH']}`,
        PAIRLOBBY_DATA_DIR: join(directory, 'device'),
        PAIRLOBBY_TEST_RECORD: record,
        PAIRLOBBY_TEST_USAGE_LIMIT_ONCE: join(directory, 'usage-limit-reported')
    };
    const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');
    const joined: Joined[] = [];

    async function command<T = unknown>(args: string[]): Promise<T> {
        return new Promise((done, reject) => {
            const child = spawn(process.execPath, [cli, ...args], {env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
            let output = '';
            let errors = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errors += chunk; });
            child.on('error', reject);
            child.on('exit', (code) => code === 0 ? done(JSON.parse(output) as T) : reject(new Error(errors)));
        });
    }

    async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
        for (let attempt = 0; attempt < 150; attempt++) {
            if (await check()) {
                return;
            }
            await sleep(100);
        }
        throw new Error(message);
    }

    const turnStarts = () => existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter((line) => line === 'turn/start').length : 0;
    try {
        const first = await command<Joined>(['join', host.invite.code, '--server', relay.url, '--runtime', 'claude', '--as', 'claude-a', '--workdir', directory, '--model', 'fixture-model', '--json']);
        joined.push(first);
        const invite = await client.mintInvite(host.roomId, host.participantCredential);
        const second = await command<Joined>(['join', invite.code, '--server', relay.url, '--runtime', 'claude', '--as', 'claude-b', '--workdir', directory, '--model', 'fixture-model', '--json']);
        joined.push(second);

        const limited = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: first.participantId, payload: {text: 'usage-limit-fixture: shared profile', priority: 'normal'}, idempotencyKey: newId('event')});
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, limited.event.eventId)).providerWait), 'first receiver never entered provider wait');
        const queued = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: second.participantId, payload: {text: 'must stay queued behind shared profile', priority: 'normal'}, idempotencyKey: newId('event')});
        await waitFor(async () => (await command<{state: string}>(['receiver', 'status', '--room', second.roomId, '--session', second.sessionId])).state === 'provider_wait', 'second receiver did not observe the shared cooldown');
        await sleep(500);
        expect(turnStarts()).toBe(1);
        expect((await client.request(host.roomId, host.participantCredential, queued.event.eventId)).responseEventId).toBeNull();

        const retry = await command<RetryProviderResponse>(['request', 'retry-provider', limited.event.eventId, '--room', first.roomId, '--session', first.sessionId, '--json']);
        expect(retry.scheduled).toEqual([limited.event.eventId]);
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, limited.event.eventId)).responseEventId), 'targeted profile probe did not complete');
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, queued.event.eventId)).responseEventId), 'second receiver did not continue after the probe succeeded');
        expect(turnStarts()).toBe(3);
        expect((await client.request(host.roomId, host.participantCredential, limited.event.eventId)).attempt).toBe(2);
        expect((await client.request(host.roomId, host.participantCredential, queued.event.eventId)).attempt ?? 1).toBe(1);
    } finally {
        for (const receiver of joined) {
            await command(['receiver', 'stop', '--room', receiver.roomId, '--session', receiver.sessionId]);
        }
        client.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 30_000);

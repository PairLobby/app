import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';

type JoinedReceiver = {
    roomId: string;
    sessionId: string;
    participantId: string;
};

type CommandContext = {
    cli: string;
    environment: NodeJS.ProcessEnv;
};

function command(context: CommandContext, args: string[]): Promise<any> {
    return new Promise((done, reject) => {
        const child = spawn(process.execPath, [context.cli, ...args], {env: context.environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
        let output = '';
        let errors = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { errors += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? done(JSON.parse(output)) : reject(new Error(errors)));
    });
}

test('managed receiver records answered and timed-out executions as separate immutable attempts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-attempt-integration-'));
    const executable = join(directory, 'codex');
    copyFileSync(resolve('scripts/fixtures/codex-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('attempt journal', {displayName: 'owner', kind: 'human'});
    const dataDirectory = join(directory, 'device');
    const context = {
        cli: process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js'),
        environment: {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: dataDirectory, PAIRLOBBY_TEST_RECORD: join(directory, 'calls.txt'), PAIRLOBBY_NO_UPDATE_CHECK: '1'}
    };
    let joined: JoinedReceiver | undefined;

    async function waitForTerminal(eventId: string): Promise<void> {
        for (let attempt = 0; attempt < 150; attempt++) {
            const request = await client.request(host.roomId, host.participantCredential, eventId);
            if (request.responseEventId || request.failureAt) {
                return;
            }
            await sleep(100);
        }
        throw new Error('managed request did not reach a terminal outcome');
    }

    async function waitForReceiverState(state: string, eventId?: string): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt++) {
            const status = await command(context, ['receiver', 'status', '--room', joined!.roomId, '--session', joined!.sessionId]);
            if (status.state === state && (!eventId || status.eventId === eventId)) {
                return;
            }
            await sleep(50);
        }
        throw new Error(`receiver did not reach ${state}`);
    }

    try {
        joined = await command(context, ['join', host.invite.code, '--server', relay.url, '--runtime', 'codex', '--as', 'codex', '--workdir', directory, '--model', 'fixture-model', '--task-idle-timeout', '3s', '--task-timeout', '10s', '--json']) as JoinedReceiver;
        const answered = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'answer normally', priority: 'normal'}, idempotencyKey: newId('event')});
        await waitForTerminal(answered.event.eventId);
        const cancelled = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'hold-for-interrupt', priority: 'normal'}, idempotencyKey: newId('event')});
        await waitForReceiverState('working', cancelled.event.eventId);
        await client.resolveRequest(host.roomId, host.participantCredential, cancelled.event.eventId, 'cancel', 'No longer needed');
        await waitForReceiverState('available');
        const timedOut = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'hang-until-crash', priority: 'normal'}, idempotencyKey: newId('event')});
        await waitForTerminal(timedOut.event.eventId);
        await command(context, ['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]);

        const answeredAttempt = (await command(context, ['receiver', 'attempts', '--room', joined.roomId, '--session', joined.sessionId, '--request', answered.event.eventId])).attempts;
        expect(answeredAttempt).toHaveLength(1);
        expect(answeredAttempt[0]).toMatchObject({ordinal: 1, runtime: 'codex', resolvedModel: 'fixture-model', answerSaved: true, runtimeStarted: {turnId: expect.any(String), processId: expect.any(Number)}, terminal: {kind: 'answered', responseEventId: expect.stringMatching(/^ev_/)}});
        const cancelledAttempt = (await command(context, ['receiver', 'attempts', '--room', joined.roomId, '--session', joined.sessionId, '--request', cancelled.event.eventId])).attempts;
        expect(cancelledAttempt).toHaveLength(1);
        expect(cancelledAttempt[0]).toMatchObject({answerSaved: false, terminal: {kind: 'cancelled', cancellationGraceful: true, failureReason: expect.stringContaining('cancelled')}});
        const timedOutAttempt = (await command(context, ['receiver', 'attempts', '--room', joined.roomId, '--session', joined.sessionId, '--request', timedOut.event.eventId])).attempts;
        expect(timedOutAttempt).toHaveLength(1);
        expect(timedOutAttempt[0]).toMatchObject({ordinal: 1, runtime: 'codex', answerSaved: false, terminal: {kind: 'idle_timeout', failureReason: expect.stringContaining('no runtime activity for 3 seconds')}});
        expect(timedOutAttempt[0]!.attemptId).not.toBe(answeredAttempt[0]!.attemptId);
        expect(readFileSync(join(directory, 'calls.txt'), 'utf8').split('\n').filter((line) => line === 'thread/start')).toHaveLength(2);
    } finally {
        if (joined) {
            await command(context, ['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]).catch(() => {});
        }
        client.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 30_000);

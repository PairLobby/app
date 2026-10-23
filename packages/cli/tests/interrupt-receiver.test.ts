import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import type {ControlOutcome} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';

type Joined = {roomId: string; sessionId: string; participantId: string; receiver: {pid: number; state: string}};

type Scenario = {runtime: 'codex' | 'claude' | 'qwen'; text: string; outcome: ControlOutcome};

const scenarios: Scenario[] = [
    {runtime: 'codex', text: 'hold-for-interrupt', outcome: 'current_turn_cancelled'},
    {runtime: 'codex', text: 'hold-for-interrupt command-lingers', outcome: 'tool_cancellation_unknown'},
    {runtime: 'claude', text: 'hold-for-interrupt', outcome: 'current_turn_cancelled'},
    {runtime: 'claude', text: 'hold-for-interrupt ignore-interrupt', outcome: 'current_turn_cancelled'},
    {runtime: 'qwen', text: 'hold-for-interrupt', outcome: 'current_turn_cancelled'},
];

test.each(scenarios)('test_interrupting_a_$runtime turn ($text) stops it, posts nothing, holds the queue and resumes', async ({runtime, text, outcome}) => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-interrupt-'));
    const record = join(directory, 'calls.txt');
    const executable = join(directory, runtime);
    copyFileSync(resolve(`scripts/fixtures/${runtime}-receiver.mjs`), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('interrupt test', {displayName: 'owner', kind: 'human'});
    const environment = {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_TEST_RECORD: record, PAIRLOBBY_INTERRUPT_GRACE_MS: '1500', PAIRLOBBY_NO_UPDATE_CHECK: '1'};
    const cli = resolve('packages/cli/dist/main.js');
    let joined: Joined | undefined;

    function command(args: string[]): Promise<any> {
        return new Promise((done, reject) => {
            const child = spawn(process.execPath, [cli, ...args], {env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
            let output = '', errors = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errors += chunk; });
            child.on('exit', (code) => code === 0 ? done(JSON.parse(output)) : reject(new Error(errors)));
        });
    }

    async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
        for (let attempt = 0; attempt < 150; attempt++) {
            if (await check()) {
                return;
            }
            await sleep(100);
        }
        throw new Error(`timed out waiting for ${what}`);
    }

    const calls = () => existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
    const member = async () => (await client.snapshot(host.roomId, host.controllerCredential)).participants.find((participant) => participant.participantId === joined!.participantId)!;
    try {
        joined = await command(['join', host.invite.code, '--server', relay.url, '--runtime', runtime, '--as', runtime, '--workdir', directory, '--model', 'fixture-model', '--json']) as Joined;
        const ask = (body: string, key: string) => client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined!.participantId, payload: {text: body, priority: 'normal'}, idempotencyKey: key});
        const first = await ask(`Long task ${text}`, 'first');
        await waitFor(async () => (await client.request(host.roomId, host.participantCredential, first.event.eventId)).turnStatus === 'running' && calls().includes('turn/start'), 'the turn to start');

        const interrupted = await client.interrupt(host.roomId, host.controllerCredential, joined.participantId);
        expect(interrupted.fenced).toEqual([first.event.eventId]);
        await waitFor(async () => ((await member()).acknowledgedRevision ?? 0) >= interrupted.revision, 'the receiver to report');
        expect(await member()).toMatchObject({paused: true, interruptRequested: true, acknowledgedOutcome: outcome});
        if (runtime === 'codex') {
            expect(calls()).toContain('turn/interrupt');
        } else if (!text.includes('ignore-interrupt')) {
            expect(calls()).toContain('interrupt');
        }

        const second = await ask('Queued task', 'second');
        await sleep(1500);
        const firstState = await client.request(host.roomId, host.participantCredential, first.event.eventId);
        expect(firstState).toMatchObject({requiresReply: false, turnStatus: 'skipped', responseEventId: null});
        expect(calls().filter((line) => line === 'turn/start')).toHaveLength(1);

        await client.control(host.roomId, host.controllerCredential, joined.participantId, false);
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, second.event.eventId)).responseEventId), 'the queued task after resume');
        const replies = (await client.readEvents(host.roomId, host.participantCredential, 0)).events.filter((event) => event.type === 'message' && event.senderId === joined!.participantId && event.replyTo === first.event.eventId);
        expect(replies).toEqual([]);
    } finally {
        if (joined) {
            await command(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]).catch(() => {});
        }
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 60_000);

test('test_interrupting_an_idle_agent_reports_that_nothing_was_running', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-interrupt-idle-'));
    const executable = join(directory, 'codex');
    copyFileSync(resolve('scripts/fixtures/codex-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('idle interrupt', {displayName: 'owner', kind: 'human'});
    const environment = {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_TEST_RECORD: join(directory, 'calls.txt'), PAIRLOBBY_NO_UPDATE_CHECK: '1'};
    const run = (args: string[]) => new Promise<any>((done, reject) => {
        const child = spawn(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.on('exit', (code) => code === 0 ? done(JSON.parse(output)) : reject(new Error(`exit ${code}`)));
    });
    const joined = await run(['join', host.invite.code, '--server', relay.url, '--runtime', 'codex', '--as', 'codex', '--workdir', directory, '--model', 'fixture-model', '--json']) as Joined;
    try {
        const result = await client.interrupt(host.roomId, host.controllerCredential, joined.participantId);
        expect(result.fenced).toEqual([]);
        let outcome: string | null = null;
        for (let attempt = 0; attempt < 100 && !outcome; attempt++) {
            await sleep(100);
            outcome = (await client.snapshot(host.roomId, host.controllerCredential)).participants.find((participant) => participant.participantId === joined.participantId)!.acknowledgedOutcome;
        }
        expect(outcome).toBe('paused_between_turns');
    } finally {
        await run(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]).catch(() => {});
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 30_000);

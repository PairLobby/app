import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';

type Joined = {roomId: string; sessionId: string; participantId: string; receiver: {pid: number; state: string}};

test.each(['codex', 'claude'])('%s CLI joins receive asynchronously and recover without repeating uncertain work', async (runtime) => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-receiver-'));
    const record = join(directory, 'calls.txt');
    const executable = join(directory, runtime);
    copyFileSync(resolve(`scripts/fixtures/${runtime}-receiver.mjs`), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('receiver test', {displayName: 'host', kind: 'human'});
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
        joined = await command(['join', host.invite.code, '--server', relay.url, '--runtime', runtime, '--as', runtime, '--workdir', directory, '--model', 'fixture-model', '--json']) as Joined;
        expect(joined.receiver.state).toBe('available');
        const scope = ['--room', joined.roomId, '--session', joined.sessionId];
        await expect(command(['channel', ...scope, '--allow-from', host.participantId])).rejects.toThrow('managed receiver already owns');
        await sleep(1200);
        expect(calls()).toEqual([]);
        const request = {type: 'message' as const, recipientId: joined.participantId, payload: {text: 'Please answer', priority: 'normal' as const}, idempotencyKey: 'first'};
        const sent = await client.send(host.roomId, host.participantCredential, request);
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, sent.event.eventId)).responseEventId));
        expect((await client.request(host.roomId, host.participantCredential, sent.event.eventId)).receivedAt).not.toBeNull();
        await client.send(host.roomId, host.participantCredential, request);
        await client.send(host.roomId, host.participantCredential, {type: 'message', payload: {text: 'Broadcast', priority: 'normal'}, idempotencyKey: 'broadcast'});
        await sleep(1200);
        expect(calls().filter((line) => line === 'turn/start')).toHaveLength(1);
        expect(calls()).toContain(runtime === 'codex' ? 'approval:decline' : 'ack:confirmed');
        if (runtime === 'claude') {
            expect(calls()).toContain('process/exit');
        }

        await command(['receiver', 'stop', ...scope]);
        const second = await client.send(host.roomId, host.participantCredential, {...request, idempotencyKey: 'second'});
        await sleep(200);
        expect((await client.request(host.roomId, host.participantCredential, second.event.eventId)).receivedAt).toBeNull();
        await command(['receiver', 'start', ...scope]);
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, second.event.eventId)).responseEventId));
        expect(calls()).toContain('thread/resume');
        expect(calls().filter((line) => line === 'turn/start')).toHaveLength(2);

        const uncertain = await client.send(host.roomId, host.participantCredential, {...request, payload: {text: 'hang-until-crash', priority: 'normal'}, idempotencyKey: 'uncertain'});
        await waitFor(async () => calls().filter((line) => line === 'turn/start').length === 3);
        const status = await command(['receiver', 'status', ...scope]);
        process.kill(status.pid, 'SIGKILL');
        await sleep(300);
        await command(['receiver', 'start', ...scope]);
        await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, uncertain.event.eventId)).failureAt));
        expect(calls().filter((line) => line === 'turn/start')).toHaveLength(3);
        const failure = await client.request(host.roomId, host.participantCredential, uncertain.event.eventId);
        expect(failure.receivedAt).toBeNull();
        expect(failure.failureReason).toContain('uncertain');
        if (runtime === 'claude') {
            const next = await client.send(host.roomId, host.participantCredential, {...request, idempotencyKey: 'after-crash'});
            await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, next.event.eventId)).responseEventId));
            expect(calls().filter((line) => line === 'thread/start')).toHaveLength(2);
            const invalid = await client.send(host.roomId, host.participantCredential, {...request, idempotencyKey: 'invalid-ack', payload: {text: 'invalid-ack', priority: 'normal'}});
            await waitFor(async () => Boolean((await client.request(host.roomId, host.participantCredential, invalid.event.eventId)).failureAt));
            expect((await client.request(host.roomId, host.participantCredential, invalid.event.eventId)).receivedAt).toBeNull();
            expect(calls()).toContain('ack:rejected');
        }
    } finally {
        if (joined) {
            await command(['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]);
        }
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 40_000);

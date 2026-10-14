import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';

import {offlineReceivers} from './receiver.js';

type Joined = {roomId: string; sessionId: string; participantId: string; receiver: {pid: number}};
type Created = {roomId: string; sessionId: string; invite: {code: string}};
type CommandContext = {cli: string; environment: NodeJS.ProcessEnv};
type CommandOutput = {stdout: string; stderr: string};

function command(context: CommandContext, args: string[]): Promise<CommandOutput> {
    return new Promise((done, reject) => {
        const child = spawn(process.execPath, [context.cli, ...args], {env: context.environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000});
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? done({stdout, stderr}) : reject(new Error(stderr)));
    });
}

async function json(context: CommandContext, args: string[]): Promise<any> {
    return JSON.parse((await command(context, args)).stdout);
}

async function killed(pid: number): Promise<void> {
    process.kill(-pid, 'SIGKILL');
    for (let check = 0; check < 100; check++) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        await sleep(50);
    }
    throw new Error('receiver did not die');
}

test('test_sending_a_message_starts_a_dead_receiver_again_and_leaves_a_stopped_one_alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-receiver-wake-'));
    const executable = join(directory, 'codex');
    copyFileSync(resolve('scripts/fixtures/codex-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const dataDirectory = join(directory, 'device');
    const store = new LocalStore(dataDirectory);
    const context = {cli: process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js'), environment: {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: dataDirectory, PAIRLOBBY_TEST_RECORD: join(directory, 'calls.txt'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_ROOM: '', PAIRLOBBY_SESSION: ''}};
    const agents: Joined[] = [];
    try {
        const room = await json(context, ['create', '--name', 'wake', '--as', 'owner', '--human', '--server', relay.url, '--manual-receive', '--json']) as Created;
        const second = (await json(context, ['invite', '--room', room.roomId, '--session', room.sessionId, '--json'])).code as string;
        agents.push(await json(context, ['join', room.invite.code, '--server', relay.url, '--runtime', 'codex', '--as', 'crashed', '--workdir', directory, '--json']) as Joined);
        agents.push(await json(context, ['join', second, '--server', relay.url, '--runtime', 'codex', '--as', 'stopped', '--workdir', directory, '--json']) as Joined);
        const [crashed, stopped] = agents as [Joined, Joined];

        // A restart kills the receiver without it recording a stop; `receiver stop` is a deliberate choice.
        await killed(crashed.receiver.pid);
        await command(context, ['receiver', 'stop', '--room', room.roomId, '--session', stopped.sessionId]);
        expect((await json(context, ['receiver', 'status', '--room', room.roomId, '--session', crashed.sessionId])).state).toBe('offline');
        expect(offlineReceivers(store, room.roomId).map((session) => session.sessionId)).toEqual([crashed.sessionId]);

        const sent = await command(context, ['send', 'are you there?', '--to', 'crashed', '--room', room.roomId, '--session', room.sessionId, '--no-wait']);
        expect(sent.stderr).toContain('started crashed again; its receiver was not running');
        const status = await json(context, ['receiver', 'status', '--room', room.roomId, '--session', crashed.sessionId]);
        expect(status.state).not.toBe('offline');
        expect(status.pid).not.toBe(crashed.receiver.pid);
        expect((await json(context, ['receiver', 'status', '--room', room.roomId, '--session', stopped.sessionId])).state).toBe('stopped');
        expect(offlineReceivers(store, room.roomId)).toEqual([]);

        const credential = store.credential(room.roomId, room.sessionId)!;
        for (let check = 0; check < 200; check++) {
            const requests = await client.pendingRequests(room.roomId, credential);
            if (!requests.some((request) => request.text === 'are you there?')) {
                return;
            }
            await sleep(50);
        }
        throw new Error('the woken receiver did not answer the waiting request');
    } finally {
        for (const agent of agents) {
            await command(context, ['receiver', 'stop', '--room', agent.roomId, '--session', agent.sessionId]).catch(() => {});
        }
        client.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 60_000);

import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';
import type {SpawnResult} from './spawn-agent.js';

type Created = {roomId: string; sessionId: string; participantId: string};

test('spawned Claude, Codex and Qwen wait without inference, overlap independent tasks, and retain configuration on restart', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pairlobby-spawn-receiver-')));
    const data = join(directory, 'device');
    const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');
    const relay = await startServer({port: 0, dataFile: join(directory, 'room.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const store = new LocalStore(data);
    const agents: SpawnResult[] = [];
    for (const runtime of ['codex', 'claude', 'qwen']) {
        copyFileSync(resolve(`scripts/fixtures/${runtime}-receiver.mjs`), join(directory, runtime));
        chmodSync(join(directory, runtime), 0o755);
    }
    async function command<T>(args: string[], runtime = 'owner'): Promise<T> {
        return new Promise((done, reject) => {
            const child = spawn(process.execPath, [cli, ...args, '--json'], {
                cwd: directory, env: {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: data, PAIRLOBBY_SESSION: '', PAIRLOBBY_ROOM: '', PAIRLOBBY_TEST_RECORD: join(directory, `${runtime}.calls`), PAIRLOBBY_TEST_DELAY_MS: '6500'},
                stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000
            });
            let stdout = '', stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('error', reject);
            child.on('close', (code) => code === 0 ? done(JSON.parse(stdout) as T) : reject(new Error(stderr)));
        });
    }
    async function waitFor(check: () => Promise<boolean>): Promise<void> {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await check()) {
                return;
            }
            await sleep(100);
        }
        throw new Error('Spawn receiver assertion timed out');
    }
    const calls = (runtime: string) => existsSync(join(directory, `${runtime}.calls`)) ? readFileSync(join(directory, `${runtime}.calls`), 'utf8') : '';
    try {
        const owner = await command<Created>(['create', '--name', 'spawning', '--human', '--as', 'human', '--server', relay.url]);
        const credential = store.credential(owner.roomId, owner.sessionId)!;
        const controller = store.credential(owner.roomId, 'controller')!;
        async function spawnAgent(runtime: string, name?: string): Promise<SpawnResult> {
            const agent = await command<SpawnResult>(['spawn', runtime, 'fixture-model', '--room', owner.roomId, '--workdir', directory, '--task-idle-timeout', '12m', '--task-timeout', '2h', ...(name ? ['--name', name] : []), ...(runtime !== 'qwen' ? ['--effort', 'high'] : [])], runtime);
            agents.push(agent);
            expect(agent.receiver?.state).toBe('available');
            expect(agent).toMatchObject({idleTimeoutMs: 720_000, absoluteTimeoutMs: 7_200_000});
            expect(agent.sessionId).not.toBe(owner.sessionId);
            expect(agent.workdir).toBe(directory);
            return agent;
        }
        async function request(agent: SpawnResult): Promise<string> {
            return (await client.send(owner.roomId, credential, {type: 'message', recipientId: agent.participantId, payload: {text: 'declare-working Independent task', priority: 'normal'}, idempotencyKey: newId('event')})).event.eventId;
        }
        const claude = await spawnAgent('claude', 'builder');
        await sleep(250);
        expect(calls('claude')).toBe('');
        const first = await request(claude);
        await waitFor(async () => Boolean((await client.request(owner.roomId, credential, first)).workingAt));
        const codex = await spawnAgent('codex');
        expect(calls('codex')).toBe('');
        const second = await request(codex);
        await sleep(250);
        expect(calls('codex')).toBe('');
        expect((await client.turnQueue(owner.roomId, credential)).mode).toBe('sequential');
        await client.setTurnMode(owner.roomId, controller, 'parallel');
        const qwen = await spawnAgent('qwen');
        expect(calls('qwen')).toBe('');
        const third = await request(qwen);
        await waitFor(async () => (await client.turnQueue(owner.roomId, credential)).entries.filter((entry) => entry.workingAt).length === 3);
        expect(calls('codex')).toContain('effort:high');
        expect(calls('claude')).toContain('effort:high');
        await waitFor(async () => (await Promise.all([first, second, third].map((id) => client.request(owner.roomId, credential, id)))).every((entry) => entry.responseEventId));
        const replay = await command<SpawnResult>(['spawn', '--resume', codex.operationId, '--room', owner.roomId]);
        expect(replay.sessionId).toBe(codex.sessionId);
        expect((await client.snapshot(owner.roomId, credential)).participants).toHaveLength(4);
        expect(statSync(join(data, 'spawns.sqlite')).mode & 0o777).toBe(0o600);
        await command(['receiver', 'stop', '--room', owner.roomId, '--session', codex.sessionId]);
        await command(['receiver', 'start', '--room', owner.roomId, '--session', codex.sessionId], 'codex');
        const config = JSON.parse(readFileSync(join(data, 'receivers', codex.sessionId, 'config.json'), 'utf8'));
        expect(config).toMatchObject({model: 'fixture-model', effort: 'high', cwd: directory, idleTimeoutMs: 720_000, absoluteTimeoutMs: 7_200_000});
        expect(config.executable).toContain('codex');
        const invalid = await command<SpawnResult>(['spawn', 'codex', 'fixture-model', '--effort', 'ultra', '--room', owner.roomId], 'unsupported');
        agents.push(invalid);
        const unsupported = await request(invalid);
        await waitFor(async () => Boolean((await client.request(owner.roomId, credential, unsupported)).failureAt));
        expect((await client.request(owner.roomId, credential, unsupported)).failureReason).toContain('does not support effort');
        expect(calls('unsupported')).not.toContain('turn/start');
    } finally {
        for (const agent of agents) {
            await command(['receiver', 'stop', '--room', agent.roomId, '--session', agent.sessionId]);
        }
        client.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 60_000);

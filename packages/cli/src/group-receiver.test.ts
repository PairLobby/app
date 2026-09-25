import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';
import type {MessageRequest} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';

type JoinedAgent = {runtime: string; participantId: string; sessionId: string; roomId: string};
type CommandResult = {eventId?: string; delivery?: string; recipientIds?: string[]; participantId: string; sessionId: string; roomId: string};

test('Codex, Claude and Qwen coordinate group turns, see prior replies, pass and reject cancelled output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-group-receiver-'));
    const data = join(directory, 'device');
    const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');
    const relay = await startServer({port: 0, dataFile: join(directory, 'room.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const store = new LocalStore(data);
    const agents: JoinedAgent[] = [];
    for (const runtime of ['codex', 'claude', 'qwen']) {
        copyFileSync(resolve(`scripts/fixtures/${runtime}-receiver.mjs`), join(directory, runtime));
        chmodSync(join(directory, runtime), 0o755);
    }
    async function command(args: string[], runtime = 'owner'): Promise<CommandResult> {
        return new Promise((resolveDone, reject) => {
            const child = spawn(process.execPath, [cli, ...args, '--json'], {
                cwd: directory, env: {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: data, PAIRLOBBY_TEST_RECORD: join(directory, `${runtime}.calls`), PAIRLOBBY_TEST_DELAY_MS: '1200'},
                stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000
            });
            let stdout = '', stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('error', reject);
            child.on('close', (code) => code === 0 ? resolveDone(JSON.parse(stdout) as CommandResult) : reject(new Error(stderr)));
        });
    }
    async function waitFor(check: () => Promise<boolean>): Promise<void> {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await check()) {
                return;
            }
            await sleep(100);
        }
        throw new Error('Group receiver assertion timed out');
    }
    const starts = (runtime: string) => existsSync(join(directory, `${runtime}.calls`)) ? readFileSync(join(directory, `${runtime}.calls`), 'utf8').split('\n').filter((line) => line === 'turn/start').length : 0;
    try {
        const owner = await command(['create', '--name', 'group', '--human', '--as', 'owner', '--manual-receive', '--server', relay.url]);
        const credential = store.credential(owner.roomId, owner.sessionId)!;
        const controller = store.credential(owner.roomId, 'controller')!;
        for (const runtime of ['codex', 'claude', 'qwen']) {
            const invite = await client.mintInvite(owner.roomId, credential);
            agents.push({...await command(['join', invite.code, '--runtime', runtime, '--as', runtime, '--model', 'fixture-model', '--server', relay.url], runtime), runtime});
        }
        const scope = ['--room', owner.roomId, '--session', owner.sessionId];
        const first = await command(['send', 'Review the implementation', '--to', 'codex,claude,qwen', ...scope]);
        expect(first.recipientIds).toEqual(agents.map((agent) => agent.participantId));
        const deliveries = (await client.pendingRequests(owner.roomId, credential)).filter((request) => request.conversationId === first.eventId);
        expect(deliveries).toHaveLength(3);
        await waitFor(async () => starts('codex') === 1);
        expect(starts('claude')).toBe(0);
        expect(starts('qwen')).toBe(0);
        let finished: MessageRequest[] = [];
        await waitFor(async () => {
            finished = await Promise.all(deliveries.map((request) => client.request(owner.roomId, credential, request.eventId)));
            return finished.every((request) => Boolean(request.responseEventId));
        });
        expect(finished.every((request) => request.receivedAt !== null)).toBe(true);
        expect(finished[1]!.responseText).toContain('Fixture answer:');
        expect(finished[2]!.responseText).toContain('Claude fixture answer:');
        expect((await client.turnQueue(owner.roomId, credential)).entries).toHaveLength(0);

        const pass = await command(['send', 'codex-pass claude-pass qwen-pass', '--to', 'all', ...scope]);
        const passing = (await client.pendingRequests(owner.roomId, credential)).filter((request) => request.conversationId === pass.eventId);
        await waitFor(async () => (await Promise.all(passing.map((request) => client.request(owner.roomId, credential, request.eventId)))).every((request) => request.turnStatus === 'passed'));
        expect((await client.readEvents(owner.roomId, credential, 0, 200)).events.filter((event) => event.type === 'message' && event.replyTo === pass.eventId)).toHaveLength(0);

        await client.setTurnMode(owner.roomId, controller, 'parallel');
        const parallel = await command(['send', 'Parallel review', '--to', 'all', ...scope]);
        const parallelDeliveries = (await client.pendingRequests(owner.roomId, credential)).filter((request) => request.conversationId === parallel.eventId);
        await waitFor(async () => (await client.turnQueue(owner.roomId, credential)).entries.filter((entry) => entry.conversationId === parallel.eventId && entry.state === 'answering').length >= 2);
        await client.controlTurn(owner.roomId, controller, {action: 'cancel', requestId: parallel.eventId!});
        await waitFor(async () => (await Promise.all(parallelDeliveries.map((request) => client.request(owner.roomId, credential, request.eventId)))).every((request) => request.turnStatus === 'cancelled'));
        await sleep(1800);
        expect((await client.readEvents(owner.roomId, credential, 0, 200)).events.filter((event) => event.type === 'message' && event.replyTo === parallel.eventId)).toHaveLength(0);
        await waitFor(async () => agents.every((agent) => {
            const path = join(data, 'receivers', agent.sessionId, 'status.json');
            return JSON.parse(readFileSync(path, 'utf8')).state === 'available';
        }));
        const acknowledged = await command(['send', 'Confirm group receipt', '--to', 'all', '--wait-for-ack', '10', ...scope]);
        expect(acknowledged.delivery).toBe('acknowledged');
        await waitFor(async () => (await client.turnQueue(owner.roomId, credential)).entries.length === 0);
    } finally {
        for (const agent of agents) {
            await command(['receiver', 'stop', '--room', agent.roomId, '--session', agent.sessionId]);
        }
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 60_000);

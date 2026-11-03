//! A shared agent's managed receiver keeps its listing current: the CLI shares it, the
//! receiver's heartbeat shows in `receiver status`, and stopping the receiver says offline.

import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

import {PairLobbyClient} from '@pairlobby/client';
import {issueMemberToken, startServer} from '@pairlobby/local-server';
import {expect, test} from 'vitest';

type Joined = {roomId: string; sessionId: string; participantId: string};

type Status = {state: string; listing?: {listingId: string; lastHeartbeatAt: number | null; availability?: string}};

test('test_a_shared_agents_receiver_sends_heartbeats_and_says_offline_when_stopped', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-share-receiver-'));
    const damien = await issueMemberToken('damien');
    const members = join(directory, 'members.jsonl');
    writeFileSync(members, `${JSON.stringify(damien.line)}\n`);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite'), createToken: 'team-token', members: {file: members}, discovery: {loginMode: 'token', name: 'Example Corp PairLobby'}});
    const executable = join(directory, 'claude');
    copyFileSync(resolve('scripts/fixtures/claude-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const environment: NodeJS.ProcessEnv = {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_TEST_RECORD: join(directory, 'calls.txt')};
    // This test may itself run inside an agent, whose variables would make the CLI refuse setup and share.
    for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_ONLINE_ORIGIN', 'PAIRLOBBY_ACCOUNT_TOKEN', 'PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', 'PAIRLOBBY_SERVER', 'PAIRLOBBY_ROOM', 'PAIRLOBBY_SESSION']) {
        delete environment[variable];
    }
    const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');

    async function command<T>(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<T> {
        return new Promise((done, reject) => {
            const child = spawn(process.execPath, [cli, ...args], {env: {...environment, ...extra}, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000});
            let output = '';
            let errors = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { errors += chunk; });
            child.on('error', reject);
            child.on('exit', (code) => code === 0 ? done((output.trim().startsWith('{') ? JSON.parse(output) : output) as T) : reject(new Error(errors || output)));
        });
    }

    async function waitFor(check: () => Promise<boolean>): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (await check()) {
                return;
            }
            await sleep(100);
        }
        throw new Error('Heartbeat assertion timed out');
    }

    let scope: string[] = [];
    try {
        await command(['setup', relay.url, '--name', 'team', '--yes']);
        await command(['login'], {PAIRLOBBY_ACCOUNT_TOKEN: damien.token, PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN: relay.url});
        const host = await new PairLobbyClient(relay.url, damien.token).createRoom('payments', {displayName: 'damien', kind: 'human'});
        const joined = await command<Joined>(['join', host.invite.code, '--server', relay.url, '--runtime', 'claude', '--as', 'backend-reviewer', '--workdir', directory, '--model', 'fixture-model', '--json']);
        scope = ['--room', joined.roomId, '--session', joined.sessionId];

        const shared = await command<{listing: {listingId: string; connection: string; model: unknown}}>(['share', ...scope, '--topic', 'Payment reconciliation', '--yes', '--json']);
        expect(shared.listing).toMatchObject({connection: 'separate', model: {value: 'fixture-model', source: 'configured'}});
        await waitFor(async () => (await command<Status>(['receiver', 'status', ...scope])).listing?.availability === 'available');
        expect((await command<Status>(['receiver', 'status', ...scope])).listing).toMatchObject({listingId: shared.listing.listingId, lastHeartbeatAt: expect.any(Number)});
        expect(await command<string>(['shared'])).toMatch(/backend-reviewer {2}payments {2}"Payment reconciliation" {2}questions {2}available, heartbeat/);

        await command(['receiver', 'stop', ...scope]);
        expect((await command<Status>(['receiver', 'status', ...scope])).listing?.availability).toBe('offline');
    } finally {
        if (scope.length) {
            await command(['receiver', 'stop', ...scope]).catch(() => {});
        }
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 60_000);

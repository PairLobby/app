import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {expect, test} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';

type Joined = {roomId: string; sessionId: string; participantId: string; receiver: {pid: number}};
type CommandContext = {cli: string; environment: NodeJS.ProcessEnv};

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

test('stale working receivers finish their request before the installed entrypoint refreshes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-receiver-refresh-'));
    const executable = join(directory, 'codex');
    copyFileSync(resolve('scripts/fixtures/codex-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const host = await client.createRoom('refresh receiver', {displayName: 'owner', kind: 'human'});
    const dataDirectory = join(directory, 'device');
    const context = {cli: process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js'), environment: {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: dataDirectory, PAIRLOBBY_TEST_RECORD: join(directory, 'calls.txt'), PAIRLOBBY_TEST_DELAY_MS: '2500', PAIRLOBBY_TEST_RECEIVER_VERSION: '0.8.0', PAIRLOBBY_TEST_RECEIVER_ENTRYPOINT: '/old/pairlobby/main.mjs', PAIRLOBBY_NO_UPDATE_CHECK: '1'}};
    let joined: Joined | undefined;
    try {
        joined = await command(context, ['join', host.invite.code, '--server', relay.url, '--runtime', 'codex', '--as', 'codex', '--workdir', directory, '--json']) as Joined;
        const sent = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'finish before refreshing', priority: 'normal'}, idempotencyKey: newId('event')});
        const scope = ['--room', joined.roomId, '--session', joined.sessionId];
        let working: any;
        for (let check = 0; check < 100; check++) {
            working = await command(context, ['receiver', 'status', ...scope]);
            if (working.state === 'working') {
                break;
            }
            await sleep(50);
        }
        expect(working).toMatchObject({state: 'working', pid: joined.receiver.pid});
        expect(await command(context, ['receiver', 'refresh'])).toEqual({restarted: [], scheduled: [joined.sessionId], current: [], stopped: [], failed: []});
        for (let check = 0; check < 200; check++) {
            const request = await client.request(host.roomId, host.participantCredential, sent.event.eventId);
            const status = await command(context, ['receiver', 'status', ...scope]);
            if (request.responseEventId && status.state === 'available' && status.restartRequired === false && status.pid !== joined.receiver.pid) {
                expect(request.failureAt ?? null).toBeNull();
                return;
            }
            await sleep(50);
        }
        throw new Error('receiver did not refresh after completing the active request');
    } finally {
        if (joined) {
            await command(context, ['receiver', 'stop', '--room', joined.roomId, '--session', joined.sessionId]).catch(() => {});
        }
        client.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 30_000);

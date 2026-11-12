import {execFile} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';
import {expect, test, vi} from 'vitest';

type Joined = {roomId: string; sessionId: string; participantId: string; invite?: {code: string}; receiver: {state: string} | null; manualReceiveWarning?: string};
type CommandResult = {body: Joined; stderr: string};
type RawCommandResult = {stdout: string; stderr: string};
type Fixture = {directory: string; device: string; client: PairLobbyClient; run: (args: string[], extra?: NodeJS.ProcessEnv) => Promise<RawCommandResult>; command: (args: string[], extra?: NodeJS.ProcessEnv) => Promise<CommandResult>; userCommand: (args: string[], extra?: NodeJS.ProcessEnv) => Promise<RawCommandResult>; cleanup: () => Promise<void>};

const execute = promisify(execFile);
const USER_TERMINAL = `import errno, os, pty, subprocess, sys
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
try:
    while True:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
finally:
    os.close(master)
sys.exit(child.wait())
`;

async function fixture(): Promise<Fixture> {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-auto-default-'));
    const device = join(directory, 'device');
    const executable = join(directory, 'codex');
    copyFileSync(resolve('scripts/fixtures/codex-receiver.mjs'), executable);
    chmodSync(executable, 0o755);
    const relay = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const env: NodeJS.ProcessEnv = {...process.env, PATH: `${directory}:${process.env['PATH']}`, PAIRLOBBY_DATA_DIR: device, PAIRLOBBY_PORT: '0', PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_NO_NETWORK_SEARCH: '1', PAIRLOBBY_SERVER: '', PAIRLOBBY_SESSION: '', PAIRLOBBY_ROOM: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CODEX_CONVERSATION_ID: '', CLAUDE_CODE_SESSION_ID: '', PAIRLOBBY_TEST_RECORD: join(directory, 'model-calls.txt')};
    const cli = resolve('packages/cli/dist/main.js');
    const run = (args: string[], extra: NodeJS.ProcessEnv = {}): Promise<RawCommandResult> => execute(process.execPath, [cli, ...args], {env: {...env, ...extra}, cwd: directory, timeout: 15_000});
    const userCommand = (args: string[], extra: NodeJS.ProcessEnv = {}): Promise<RawCommandResult> => execute('python3', ['-c', USER_TERMINAL, process.execPath, cli, ...args], {env: {...env, ...extra}, cwd: directory, timeout: 15_000});
    const command = async (args: string[], extra: NodeJS.ProcessEnv = {}): Promise<CommandResult> => {
        const result = await run([...args, '--json'], extra);
        return {body: JSON.parse(result.stdout) as Joined, stderr: result.stderr};
    };
    return {
        directory, device, client, run, command, userCommand,
        async cleanup() {
            const store = new LocalStore(device);
            for (const room of store.rooms()) {
                for (const session of room.sessions) {
                    if (existsSync(join(device, 'receivers', session.sessionId, 'config.json'))) {
                        await command(['receiver', 'stop', '--room', room.roomId, '--session', session.sessionId]);
                    }
                }
            }
            await relay.close();
            rmSync(directory, {recursive: true, force: true});
        }
    };
}

test.each([false, true])('automatic receiving remains the default with manual permission %s', async (allowed) => {
    const context = await fixture();
    try {
        if (allowed) {
            await context.userCommand(['settings', 'allow-manual-receive', 'on']);
        }
        const {body: created} = await context.command(['create', '--name', 'automatic', '--as', 'helper', '--runtime', 'codex', '--server', context.client.serverUrl, '--workdir', context.directory, '--model', 'fixture-model']);
        expect(created.receiver?.state).toBe('available');
        expect(created.manualReceiveWarning).toBeUndefined();
        const human = await context.client.redeemInvite(created.invite!.code, {displayName: 'human', kind: 'human'});
        const sent = await context.client.send(created.roomId, human.participantCredential, {type: 'message', recipientId: created.participantId, payload: {text: 'Please answer', priority: 'normal'}, idempotencyKey: newId('event')});
        await vi.waitFor(async () => {
            const request = await context.client.request(created.roomId, human.participantCredential, sent.event.eventId);
            expect(request.receivedAt).not.toBeNull();
            expect(request.responseEventId).not.toBeNull();
        }, {timeout: 10_000, interval: 50});
    } finally {
        await context.cleanup();
    }
}, 30_000);

test.each(['create', 'join'])('explicit manual %s warns visibly and does not start an automatic receiver', async (action) => {
    const context = await fixture();
    try {
        await context.userCommand(['settings', 'allow-manual-receive', 'on']);
        const args = action === 'create' ? ['create', '--name', 'manual'] : ['join', (await context.client.createRoom('manual', {displayName: 'human', kind: 'human'})).invite.code];
        const {body: joined, stderr} = await context.command([...args, '--as', 'helper', '--runtime', 'codex', '--manual-receive', '--server', context.client.serverUrl, '--workdir', context.directory]);
        expect(joined.receiver).toBeNull();
        expect(joined.manualReceiveWarning).toContain('--manual-receive');
        expect(stderr).toContain(joined.manualReceiveWarning);
        expect(existsSync(join(context.device, 'receivers', joined.sessionId, 'config.json'))).toBe(false);
        expect(existsSync(join(context.directory, 'model-calls.txt'))).toBe(false);
    } finally {
        await context.cleanup();
    }
}, 30_000);

test.each([
    ['create', '--name', 'blocked', '--runtime', 'codex'],
    ['create', '--name', 'blocked', '--human'],
    ['create', 'online', '--name', 'blocked', '--runtime', 'codex'],
    ['join', 'ABCD-EFGH', '--runtime', 'codex'],
    ['join', 'online', 'ABCD-EFGH', '--runtime', 'codex']
])('manual flag is rejected before side effects: %j', async (...args) => {
    const context = await fixture();
    try {
        await expect(context.run([...args, '--manual-receive', '--server', 'http://127.0.0.1:1', '--json'])).rejects.toMatchObject({code: 2, stderr: expect.stringContaining('--manual-receive is disabled')});
        const store = new LocalStore(context.device);
        expect(store.settings().allowManualReceive).toBe(false);
        expect(store.rooms()).toEqual([]);
        expect(existsSync(join(context.device, 'credentials.json'))).toBe(false);
    } finally {
        await context.cleanup();
    }
});

test('a refused manual join neither consumes its invite nor creates a membership', async () => {
    const context = await fixture();
    try {
        const room = await context.client.createRoom('intact invite', {displayName: 'human', kind: 'human'});
        await expect(context.command(['join', room.invite.code, '--runtime', 'codex', '--manual-receive', '--server', context.client.serverUrl])).rejects.toMatchObject({stderr: expect.stringContaining('--manual-receive is disabled')});
        expect((await context.client.snapshot(room.roomId, room.participantCredential)).participants).toHaveLength(1);
        await context.userCommand(['settings', 'allow-manual-receive', 'on']);
        const {body} = await context.command(['join', room.invite.code, '--runtime', 'codex', '--manual-receive', '--server', context.client.serverUrl]);
        expect(body.receiver).toBeNull();
        expect((await context.client.snapshot(room.roomId, room.participantCredential)).participants).toHaveLength(2);
    } finally {
        await context.cleanup();
    }
});

test('manual permission can be enabled only by a user terminal, then off/reset restores the denial', async () => {
    const context = await fixture();
    try {
        await expect(context.run(['settings', 'allow-manual-receive', 'on', '--human'])).rejects.toMatchObject({stderr: expect.stringContaining('Only a person at an interactive terminal')});
        for (const extra of [{CODEX_THREAD_ID: 'agent-thread'}, {CLAUDE_CODE_SESSION_ID: 'agent-session'}]) {
            await expect(context.userCommand(['settings', 'allow-manual-receive', 'on', '--human'], extra)).rejects.toMatchObject({stdout: expect.stringContaining('Agent sessions cannot enable')});
        }
        await expect(context.userCommand(['settings', 'allow-manual-receive', 'on', '--runtime', 'qwen', '--human'])).rejects.toMatchObject({stdout: expect.stringContaining('Agent sessions cannot enable')});
        const store = new LocalStore(context.device);
        expect(store.settings().allowManualReceive).toBe(false);
        await context.userCommand(['settings', 'allow-manual-receive', 'on']);
        expect(store.settings().allowManualReceive).toBe(true);
        await context.userCommand(['settings', 'allow-manual-receive', 'off']);
        expect(store.settings().allowManualReceive).toBe(false);
        await context.userCommand(['settings', 'allow-manual-receive', 'on']);
        await context.run(['settings', '--reset']);
        expect(store.settings().allowManualReceive).toBe(false);
        await expect(context.run(['create', '--manual-receive', '--human', '--server', 'http://127.0.0.1:1'])).rejects.toMatchObject({stderr: expect.stringContaining('--manual-receive is disabled')});
    } finally {
        await context.cleanup();
    }
}, 30_000);

test('an agent session cannot use --human to enable manual permission', async () => {
    const context = await fixture();
    try {
        const {body} = await context.command(['create', '--name', 'agent permission', '--runtime', 'codex', '--server', context.client.serverUrl, '--workdir', context.directory, '--model', 'fixture-model']);
        await expect(context.userCommand(['settings', 'allow-manual-receive', 'on', '--human', '--session', body.sessionId])).rejects.toMatchObject({stdout: expect.stringContaining('Agent sessions cannot enable')});
        await expect(context.userCommand(['settings', 'allow-manual-receive', 'on', '--human'], {PAIRLOBBY_SESSION: body.sessionId})).rejects.toMatchObject({stdout: expect.stringContaining('Agent sessions cannot enable')});
        expect(new LocalStore(context.device).settings().allowManualReceive).toBe(false);
    } finally {
        await context.cleanup();
    }
}, 30_000);

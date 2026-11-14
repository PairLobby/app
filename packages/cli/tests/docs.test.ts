import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {LocalStore} from '@pairlobby/client';
import {newCredential, newId} from '@pairlobby/protocol';
import {expect, test} from 'vitest';
import {chatDocumentation, documentation} from '../src/docs.js';
import {documentationTool} from '../src/documentation-tool.js';
import {commandMatches} from '../src/chat-completion.js';
import {VERSION} from '../src/version.js';
import type {DocSection} from '../src/docs/catalog.js';

const execute = promisify(execFile);
const cli = process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js');

test('topic and full reference include implemented operations and explicit availability limits', () => {
    const index = documentation({version: VERSION});
    expect(index.topics.map((topic) => topic.id)).toEqual(expect.arrayContaining(['files', 'device-settings', 'directory', 'team-relays', 'protocol']));
    expect(documentation({version: VERSION, topic: 'files'}).markdown).toContain('until-received');
    expect(documentation({version: VERSION, topic: 'limits'}).markdown).toContain('PAIRLOBBY_ROOM_MAX_PARTICIPANTS');
    const settings = documentation({version: VERSION, topic: 'settings'}).markdown;
    expect(settings).toContain('| `allow-manual-receive` | off |');
    expect(settings).toContain('| `managed-task-timeout` | 1h |');
    const complete = documentation({version: VERSION, all: true});
    expect(complete.markdown).toContain('PAIRLOBBY_BACKUP_S3_ENDPOINT');
    expect(complete.markdown).toContain('pairlobby invitations');
    expect(complete.markdown).toContain('destination API is not implemented');
    expect(complete.sections.length).toBeGreaterThan(25);
});

test('search includes configuration topics as well as command names', () => {
    const files = documentation({version: VERSION, search: 'file receipt'});
    expect(files.commands.map((command) => command.id)).toEqual(expect.arrayContaining(['room-attach', 'sh-send', 'sh-reply']));
    const setting = documentation({version: VERSION, search: 'managed-task-timeout'});
    expect(setting.topics.some((topic) => topic.id === 'device-settings')).toBe(true);
    expect(documentation({version: VERSION, search: 'unfindable-doc-test-word'}).markdown).toContain('No matches');
});

test('chat lookup and completion expose the same read-only reference', () => {
    expect(chatDocumentation('files', VERSION)).toBe(documentation({version: VERSION, topic: 'files'}).markdown);
    expect(chatDocumentation('--search "file receipt"', VERSION)).toContain('until-received');
    expect(chatDocumentation('', VERSION)).toContain('/docs files');
    expect(commandMatches('/docs dev')).toContain('/docs device-settings ');
    expect(() => documentation({version: VERSION, topic: 'files', all: true})).toThrow('Choose one');
});

test('the CLI reference works with an unusable data directory and does not expose environment tokens', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-offline-docs-'));
    const blocked = join(directory, 'not-a-directory');
    writeFileSync(blocked, 'The docs command must not open a device store.');
    const env = {...process.env, PAIRLOBBY_DATA_DIR: blocked, PAIRLOBBY_SERVER: 'http://127.0.0.1:1', PAIRLOBBY_ACCOUNT_TOKEN: 'never-include-this-doc-test-token', PAIRLOBBY_PORT: '0', PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_NO_NETWORK_SEARCH: '1'};
    try {
        const {stdout} = await execute(process.execPath, [cli, 'docs', '--all', '--json'], {cwd: directory, env, maxBuffer: 2 * 1024 * 1024});
        const reference = JSON.parse(stdout);
        expect(reference.version).toBe(VERSION);
        expect(reference.kind).toBe('all');
        expect(reference.sections.some((section: DocSection) => section.id === 'device-settings')).toBe(true);
        expect(stdout).not.toContain(env.PAIRLOBBY_ACCOUNT_TOKEN);
        expect(readdirSync(directory)).toEqual(['not-a-directory']);
        const help = await execute(process.execPath, [cli, 'docs', '--help'], {cwd: directory, env});
        expect(help.stdout).toContain('No account, room, relay or internet');
        await expect(execute(process.execPath, [cli, 'docs', '--manual-receive'], {cwd: directory, env})).rejects.toThrow('is offline');
        await expect(execute(process.execPath, [cli, 'docs', 'not-a-topic'], {cwd: directory, env})).rejects.toThrow('Unknown documentation topic');
        expect(existsSync(join(directory, 'registry.json'))).toBe(false);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test('the agent documentation tool accepts only scoped reference lookups', () => {
    expect(documentationTool({topic: 'files'})).toContain('Confirm saved');
    expect(documentationTool({})).toContain('Choose a topic');
    expect(() => documentationTool({topic: 'files', search: 'receipt'})).toThrow('Choose one');
    expect(() => documentationTool({room: 'rm_private'})).toThrow('only topic or search');
    expect(() => documentationTool({search: 'x'.repeat(257)})).toThrow('256');
});

test('the Claude/Qwen bridge can read docs offline without acknowledging a request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-mcp-docs-'));
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.writeHead(503); response.end(); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('No test address');
    }
    const store = new LocalStore(directory);
    const roomId = newId('room');
    const sessionId = newId('session');
    const credential = newCredential('participant');
    store.upsertRoom({roomId, name: 'offline documentation', serverUrl: `http://127.0.0.1:${address.port}`, createdAt: Date.now(), expiresAt: null, controls: false, sessions: []});
    store.addSession(roomId, {sessionId, participantId: newId('participant'), displayName: 'docs reader', kind: 'agent', role: 'member', runtime: 'claude', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory});
    store.putCredential(roomId, sessionId, credential);
    mkdirSync(join(directory, 'receivers', sessionId), {recursive: true});
    const transport = new StdioClientTransport({command: process.execPath, args: [cli, 'receiver-tools', '--room', roomId, '--session', sessionId, '--request', newId('event')], env: {PAIRLOBBY_DATA_DIR: directory, PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_NO_NETWORK_SEARCH: '1', PAIRLOBBY_PORT: '0'}, stderr: 'pipe'});
    const client = new Client({name: 'docs-test', version: '1.0.0'});
    try {
        await client.connect(transport);
        expect((await client.listTools()).tools.find((tool) => tool.name === 'documentation')?.annotations?.readOnlyHint).toBe(true);
        const result = await client.callTool({name: 'documentation', arguments: {topic: 'device-settings'}});
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).toContain('allow-manual-receive');
        expect(JSON.stringify(result)).not.toContain(credential);
        expect(requests).toBe(0);
        // No owner lock or running job exists: ordinary acknowledgement remains refused.
        expect((await client.callTool({name: 'acknowledge_message', arguments: {}})).isError).toBe(true);
        expect(requests).toBe(0);
    } finally {
        await client.close();
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(directory, {recursive: true, force: true});
    }
}, 15000);

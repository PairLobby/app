import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {afterEach, beforeEach, expect, test} from 'vitest';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

type CreatedJson = {roomId: string; invite: {code: string}};

type ReadJson = {events: {type: string; payload: {text?: string}}[]};

const execute = promisify(execFile);
let directory: string;
let relay: RunningServer;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-people-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
});

afterEach(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(person: string, args: string[]): Promise<{stdout: string; stderr: string}> {
    return execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: {...process.env, PAIRLOBBY_DATA_DIR: join(directory, person), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_SERVER: ''}, timeout: 15_000});
}

async function said(person: string): Promise<string[]> {
    const page = JSON.parse((await cli(person, ['read', '--json'])).stdout) as ReadJson;
    return page.events.filter((event) => event.type === 'message').map((event) => event.payload.text ?? '');
}

test('test_three_people_with_no_agent_can_talk_every_way', async () => {
    const created = JSON.parse((await cli('ana', ['create', '--name', 'people', '--as', 'ana', '--human', '--server', relay.url, '--json'])).stdout) as CreatedJson;
    for (const person of ['bob', 'cy']) {
        const code = (await cli('ana', ['invite', '--json'])).stdout;
        await cli(person, ['join', (JSON.parse(code) as {code: string}).code, '--server', relay.url, '--as', person, '--human', '--json']);
    }
    expect(created.roomId).toMatch(/^rm_/);
    expect((await cli('ana', ['send', 'to everyone', '--to', 'all', '--no-wait'])).stderr).toMatch(/no agent to ask/);
    await cli('ana', ['send', 'to bob and cy', '--to', 'bob,cy', '--no-wait']);
    await cli('ana', ['send', 'to bob only', '--to', 'bob', '--no-wait']);
    await cli('bob', ['send', 'bob answers ana', '--to', 'ana', '--no-wait']);
    expect(await said('cy')).toEqual(expect.arrayContaining(['to everyone', 'to bob and cy', 'to bob only', 'bob answers ana']));
});

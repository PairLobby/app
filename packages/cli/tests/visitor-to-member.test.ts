//! An owner turns a visitor into a member in place, so they can post, without a new code.

import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {roleChange} from '../src/render.js';

type Created = {roomId: string; name: string};
type Changed = {roomId: string; participantId: string; role: string; previousRole: string};

const execute = promisify(execFile);
let directory: string;
let relay: RunningServer;
let client: PairLobbyClient;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-visitor-to-member-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    client = new PairLobbyClient(relay.url);
});

afterEach(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(args: string[]): Promise<string> {
    const {stdout} = await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_SERVER: ''}, timeout: 15_000});
    return stdout;
}

test('test_a_role_change_says_what_it_made_someone', () => {
    expect(roleChange('member', 'guest')).toBe('a member and can post');
    expect(roleChange('member', 'controller')).toBe('a member');
    expect(roleChange('controller', 'member')).toBe('an admin');
});

test('test_the_owner_makes_a_visitor_of_a_protected_room_a_member_who_can_post_and_then_an_admin', async () => {
    const created = JSON.parse(await cli(['create', '--name', 'office-hours', '--type', 'protected', '--as', 'owner', '--server', relay.url, '--manual-receive', '--json'])) as Created;
    const visitor = await client.joinAsGuest(created.roomId, {displayName: 'maria', kind: 'human'});
    expect(visitor.role).toBe('guest');
    const owner = visitor.room.participants.find((person) => person.displayName === 'owner')!.participantId;
    const message = () => client.send(created.roomId, visitor.participantCredential, {type: 'message', recipientId: owner, payload: {text: 'hello', priority: 'normal'}, idempotencyKey: newId('event')});
    await expect(message()).rejects.toThrow('visitors can read');

    await expect(cli(['room', created.roomId, 'admin', 'maria'])).rejects.toThrow('make them a member first');
    const changed = JSON.parse(await cli(['room', created.roomId, 'member', 'maria', '--json'])) as Changed;
    expect(changed).toEqual({roomId: created.roomId, participantId: visitor.participantId, role: 'member', previousRole: 'guest'});
    await expect(message()).resolves.toBeDefined();

    expect(await cli(['room', created.roomId, 'admin', 'maria'])).toContain('maria is now an admin');
    const snapshot = await client.snapshot(created.roomId, visitor.participantCredential);
    expect(snapshot.participants.find((person) => person.participantId === visitor.participantId)?.role).toBe('controller');
}, 60_000);

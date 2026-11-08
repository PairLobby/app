//! `pairlobby @handle`, `pairlobby directory` and `pairlobby contact` against a relay with
//! personal tokens, logged in the way a person's device is.

import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {PairLobbyClient} from '@pairlobby/client';
import {issueMemberToken, startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import type {ContactResponse, ListingView} from '@pairlobby/protocol';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {contactBanner, directoryHandle, emptyDirectory, listingLine} from '../src/directory-contact.js';

type Contacted = {roomId: string; sessionId: string; participantId: string; agentId: string; agentName: string; owner: string; reused: boolean};

const execute = promisify(execFile);
let directory: string;
let relay: RunningServer;
let damien: string;
let hugo: string;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-directory-cli-'));
    const issued = await Promise.all([issueMemberToken('damien', 'Damien'), issueMemberToken('hugo')]);
    [damien, hugo] = issued.map((member) => member.token) as [string, string];
    const members = join(directory, 'members.jsonl');
    writeFileSync(members, issued.map((member) => `${JSON.stringify(member.line)}\n`).join(''));
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite'), trustedProxyHeader: 'x-forwarded-for', members: {file: members}, discovery: {loginMode: 'token', name: 'Example Corp PairLobby'}});
});

afterEach(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

async function cli(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
    const environment: NodeJS.ProcessEnv = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_SERVER: '', ...extra};
    // This test may run inside an agent, whose variables would make the CLI refuse setup.
    for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_ACCOUNT_TOKEN', 'PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN', 'PAIRLOBBY_ROOM', 'PAIRLOBBY_SESSION']) {
        if (!(variable in extra)) {
            delete environment[variable];
        }
    }
    const {stdout} = await execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env: environment, timeout: 15_000});
    return stdout;
}

const listing: ListingView = {listingId: 'li_1', owner: {handle: 'damien'}, agentName: 'claude-payments', roomName: 'payments', topic: 'Payment reconciliation', contact: 'questions', connection: 'separate', availability: 'available', lastSeenAt: 1_000, lastMessageAt: null, createdAt: 0, updatedAt: 0} as ListingView;

test('test_directory_lines_say_who_shares_what_and_what_a_contact_will_get', () => {
    expect(directoryHandle(' @Damien ')).toBe('damien');
    expect(listingLine(listing, 61_000)).toBe('claude-payments (@damien) · Payment reconciliation · available, heard from 1 minute ago');
    expect(emptyDirectory('nobody', false)).toBe('No one on this relay is called @nobody.');
    expect(emptyDirectory('omar', true)).toBe('@omar shares no agent you can see right now.');
    const contact = {agentName: 'claude-payments', owner: 'damien', contact: 'questions', connection: 'separate'} as ContactResponse;
    expect(contactBanner(contact)).toBe('You reached claude-payments, shared by @damien, through the directory. It takes questions, read-only, answered from a separate conversation in the same project. Messages go to claude-payments; /to changes that.');
});

test('test_a_logged_in_person_finds_damiens_agent_by_handle_and_contacts_it_once', async () => {
    const owner = new PairLobbyClient(relay.url, damien);
    const room = await owner.createRoom('payments', {displayName: 'damien', kind: 'human'});
    const agent = await owner.redeemInvite((await owner.mintInvite(room.roomId, room.controllerCredential, 'member', false)).code, {displayName: 'claude-payments', kind: 'agent'});
    const shared = await owner.shareListing(agent.participantCredential, {roomId: room.roomId, topic: 'Payment reconciliation', contact: 'questions', connection: 'separate'});

    await cli(['setup', relay.url, '--name', 'team', '--yes']);
    await cli(['login'], {PAIRLOBBY_ACCOUNT_TOKEN: hugo, PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN: relay.url});
    expect(await cli(['@Damien'])).toContain(`${shared.listingId}  claude-payments (@damien) · Payment reconciliation`);
    expect((await cli(['@nobody'])).trim()).toBe('No one on this relay is called @nobody.');
    expect((JSON.parse(await cli(['directory', '--json'])) as {listings: ListingView[]}).listings.map((entry) => entry.listingId)).toEqual([shared.listingId]);

    const first = JSON.parse(await cli(['contact', shared.listingId, '--as', 'hugo', '--json'])) as Contacted;
    expect(first).toMatchObject({roomId: room.roomId, agentId: agent.participantId, agentName: 'claude-payments', owner: 'damien', reused: false});
    const again = JSON.parse(await cli(['contact', shared.listingId, '--json'])) as Contacted;
    expect(again).toMatchObject({sessionId: first.sessionId, participantId: first.participantId, reused: true});
    const hugoInRoom = (await owner.snapshot(room.roomId, room.participantCredential)).participants.find((person) => person.participantId === first.participantId);
    expect(hugoInRoom).toMatchObject({displayName: 'hugo', kind: 'human', member: 'hugo', origin: {directory: true, listingId: shared.listingId}});
}, 60_000);

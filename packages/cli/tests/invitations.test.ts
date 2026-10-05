import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {afterEach, beforeEach, expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

import {runRoomCommand} from '../src/chat-commands.js';
import {startFakeAccountService} from './fake-account-service.js';
import type {FakeAccountService} from './fake-account-service.js';

type CliResult = {stdout: string; stderr: string};

const execute = promisify(execFile);
const TOKEN = 'test-account-token';
let directory: string;
let relay: RunningServer;
let service: FakeAccountService;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-invitations-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    service = await startFakeAccountService(relay, TOKEN);
});

afterEach(async () => {
    await service.close();
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

/** Runs the built CLI as a logged-in person, or as an agent session when `agent` is set. */
async function cli(args: string[], agent = false): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'device'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_ONLINE_ORIGIN: service.origin, PAIRLOBBY_ACCOUNT_TOKEN: TOKEN, PAIRLOBBY_SERVER: ''};
    for (const variable of ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID', 'PAIRLOBBY_SESSION', 'PAIRLOBBY_ROOM']) {
        delete env[variable];
    }
    if (agent) {
        env['CLAUDE_CODE_SESSION_ID'] = 'agent-session';
    }
    return execute(process.execPath, [resolve('packages/cli/dist/main.js'), ...args], {env, timeout: 15_000});
}

function invite(roomId: string, roomName: string) {
    return {id: `invitation-${roomId}`, roomId, roomName, invitedBy: '@maria', role: 'member' as const, agents: 1, createdAt: Date.now(), expiresAt: Date.now() + 7 * 86400_000};
}

test('test_a_person_lists_declines_and_accepts_invitations_then_joins_the_shared_room', async () => {
    const owner = await new PairLobbyClient(relay.url).createRoom('Design review', {displayName: 'maria', kind: 'human'});
    service.invitations = [invite(owner.roomId, 'Design review'), invite('rm_OTHER', 'Other room')];

    const listed = await cli(['invitations']);
    expect(listed.stdout).toContain('Design review');
    expect(listed.stdout).toMatch(/invited by @maria · member, may bring 1 agent · expires/);
    expect(JSON.parse((await cli(['invitations', '--json'])).stdout)).toMatchObject({count: 2});

    expect((await cli(['invitations', 'decline', 'Other room'])).stdout).toContain('Declined the invitation to Other room');
    await expect(cli(['invitations', 'accept', 'Other room'])).rejects.toThrow(/No unanswered invitation to "Other room"/);

    // Accepting only grants access; the room becomes joinable through the relay it lives on.
    await expect(cli(['join', 'online', 'Design review', '--human', '--as', 'hugo', '--json'])).rejects.toThrow(/None of your account's rooms is called "Design review"/);
    service.accepted.set(owner.roomId, {name: 'Design review', controllerCredential: owner.controllerCredential});
    const accepted = await cli(['invitations', 'accept', 'design review']);
    expect(accepted.stdout).toContain("Accepted. Design review is now one of your account's rooms.");
    expect(accepted.stdout).toContain(`pairlobby join online ${owner.roomId}`);
    expect((await cli(['invitations'])).stdout).toContain('No invitations waiting.');

    expect((await cli(['find', 'online'])).stdout).toMatch(/Design review {2}rm_\S+ · shared with you/);
    const joined = JSON.parse((await cli(['join', 'online', 'Design review', '--human', '--as', 'hugo', '--json'])).stdout) as {roomId: string; serverUrl: string; role: string};
    expect(joined).toMatchObject({roomId: owner.roomId, serverUrl: service.server, role: 'member'});
    expect(new LocalStore(join(directory, 'device')).room(owner.roomId)?.serverUrl).toBe(service.server);
});

test('test_an_agent_may_list_invitations_but_not_answer_them', async () => {
    service.invitations = [invite('rm_ROOM', 'Design review')];
    expect(JSON.parse((await cli(['invitations', '--json'], true)).stdout)).toMatchObject({count: 1});
    await expect(cli(['invitations', 'accept', 'Design review'], true)).rejects.toThrow(/answered by a person, not an agent/);
    await expect(cli(['invitations', 'decline', 'Design review'], true)).rejects.toThrow(/answered by a person, not an agent/);
    expect(service.invitations).toHaveLength(1);
    expect(service.calls.some((call) => /accept|decline/.test(call.request))).toBe(false);
});

test('test_profile_username_sets_the_account_handle_and_reports_the_services_refusal', async () => {
    expect((await cli(['profile', '--username', '@Hugo'])).stdout).toContain('Your handle is @hugo.');
    expect(service.handle).toBe('hugo');
    await expect(cli(['profile', '--username', 'maria'])).rejects.toThrow(/That handle is not available/);
    await expect(cli(['profile', '--username', 'x'])).rejects.toThrow(/3–30 characters/);
});

test('test_invite_by_handle_in_chat_asks_each_account_and_lists_and_withdraws_them', async () => {
    const hosted = new PairLobbyClient(service.server, TOKEN);
    const created = await new PairLobbyClient(relay.url).createRoom('Design review', {displayName: 'hugo', kind: 'human'});
    const context = {client: hosted, roomId: created.roomId, credential: created.participantCredential, controllerCredential: created.controllerCredential, participantId: created.participantId};

    const invited = await runRoomCommand('/invite @Maria @nobody observer', context);
    expect(invited.split('\n')).toHaveLength(2);
    expect(invited).toMatch(/Invited @maria — read-only observer, may bring 1 agent · they accept with pairlobby invitations/);
    expect(invited).toMatch(/@nobody was not invited: No account has the handle @nobody/);
    expect(service.calls.filter((call) => call.request.endsWith('/invitations') && call.request.startsWith('POST')).every((call) => call.token)).toBe(true);

    expect(await runRoomCommand('/invites', context)).toMatch(/@maria — read-only observer, may bring 1 agent · not answered yet/);
    expect(await runRoomCommand('/invites revoke @maria', context)).toBe('Invitation to @maria withdrawn.');
    expect(await runRoomCommand('/invites', context)).toMatch(/Nobody has been invited/);
    await expect(runRoomCommand('/invites revoke @maria', context)).rejects.toThrow('No invitation to @maria');
    await expect(runRoomCommand('/invite @maria admin', context)).rejects.toThrow('Usage: /invite @handle');
    await expect(runRoomCommand('/invite maria@example.com', context)).rejects.toThrow('Inviting by email is not available yet');
});

test('test_only_owners_and_admins_invite_by_handle_and_only_in_hosted_rooms', async () => {
    const created = await new PairLobbyClient(relay.url).createRoom('Design review', {displayName: 'hugo', kind: 'human'});
    const member = await new PairLobbyClient(relay.url).redeemInvite(created.invite.code, {displayName: 'claude', kind: 'agent'});
    const hosted = new PairLobbyClient(service.server, TOKEN);
    await expect(runRoomCommand('/invite @maria', {client: hosted, roomId: created.roomId, credential: member.participantCredential, participantId: member.participantId})).rejects.toThrow(/only the room owner and admins invite by @handle/);
    // A plain member can still mint a code to pass along.
    expect(await runRoomCommand('/invite', {client: hosted, roomId: created.roomId, credential: member.participantCredential, participantId: member.participantId})).toMatch(/^Invite: /);
    const local = {client: new PairLobbyClient(relay.url), roomId: created.roomId, credential: created.participantCredential, controllerCredential: created.controllerCredential, participantId: created.participantId};
    await expect(runRoomCommand('/invite @maria', local)).rejects.toThrow(/works in hosted rooms/);
    await expect(runRoomCommand('/invites', local)).rejects.toThrow(/works in hosted rooms/);
    expect(service.calls.some((call) => call.request.includes('/invitations'))).toBe(false);
});

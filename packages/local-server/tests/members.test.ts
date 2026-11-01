//! Personal tokens: the members file, and a relay that names members on the rooms they create and join.

import {mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {hashCredential, newCredential, newId} from '@pairlobby/protocol';
import {afterAll, describe, expect, test} from 'vitest';

import {MEMBER_TOKEN_PREFIX, MembersFile, MembersFileError, issueMemberToken, memberHandle, parseMembers} from '../src/members.js';
import {startServer} from '../src/server.js';

type RoomBody = {room: {roomId: string; owner?: string; participants: Array<{participantId: string; member?: string}>}; participantId: string; invite: {code: string}};

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-members-'));

afterAll(() => {
    rmSync(directory, {recursive: true, force: true});
});

const DIGEST = 'a'.repeat(64);

function write(path: string, lines: unknown[], at: number): void {
    writeFileSync(path, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));
    // A whole second apart, so the change shows in the modification time on every file system.
    utimesSync(path, at, at);
}

describe('members file', () => {
    test('test_a_members_file_maps_token_digests_to_handles_and_skips_blank_lines', () => {
        const members = parseMembers(`{"handle":"damien","name":"Damien","tokenSha256":"${DIGEST}"}\n\n{"handle":"x-y_z","tokenSha256":"${'b'.repeat(64)}"}\n`);
        expect(members.get(DIGEST)).toEqual({handle: 'damien', name: 'Damien'});
        expect(members.get('b'.repeat(64))).toEqual({handle: 'x-y_z'});
        expect(members.size).toBe(2);
    });

    test('test_a_broken_line_is_refused_by_its_number_without_repeating_its_content', () => {
        const refusals: Array<[string, string]> = [
            ['not json', 'line 1 of the members file is not JSON'],
            [`{"handle":"Damien","tokenSha256":"${DIGEST}"}`, 'needs a handle'],
            [`{"handle":"all","tokenSha256":"${DIGEST}"}`, 'needs a handle'],
            ['{"handle":"damien","tokenSha256":"plm_secret"}', 'needs tokenSha256'],
            [`{"handle":"damien","tokenSha256":"${DIGEST}"}\n{"handle":"damien","tokenSha256":"${'b'.repeat(64)}"}`, 'line 2 of the members file repeats'],
            [`{"handle":"damien","tokenSha256":"${DIGEST}"}\n{"handle":"other","tokenSha256":"${DIGEST}"}`, 'line 2 of the members file repeats']
        ];
        for (const [text, message] of refusals) {
            const thrown = (() => {
                try {
                    parseMembers(text);
                    return null;
                } catch (error) {
                    return error;
                }
            })();
            expect(thrown).toBeInstanceOf(MembersFileError);
            expect((thrown as Error).message).toContain(message);
            expect((thrown as Error).message).not.toContain('plm_secret');
        }
    });

    test('test_an_issued_token_is_a_fresh_personal_token_whose_line_holds_only_its_digest', async () => {
        const issued = await issueMemberToken('@Damien', ' Damien ');
        expect(issued.token.startsWith(MEMBER_TOKEN_PREFIX)).toBe(true);
        expect(issued.line).toEqual({handle: 'damien', name: 'Damien', tokenSha256: await hashCredential(issued.token)});
        expect(JSON.stringify(issued.line)).not.toContain(issued.token);
        expect((await issueMemberToken('damien')).token).not.toBe(issued.token);
        expect(memberHandle('everyone')).toBeNull();
        await expect(issueMemberToken('no')).rejects.toThrow(MembersFileError);
    });

    test('test_the_file_is_reread_when_it_changes_and_a_broken_one_keeps_the_members_it_had', async () => {
        const path = join(directory, 'reload.jsonl');
        const first = await issueMemberToken('damien');
        const second = await issueMemberToken('hugo');
        write(path, [first.line], 1_000_000);
        const logged: string[] = [];
        const file = new MembersFile({path, log: (line) => logged.push(line)});
        expect(await file.lookup(first.line.tokenSha256)).toEqual({handle: 'damien'});
        write(path, [second.line], 1_000_001);
        file.reload();
        expect(await file.lookup(first.line.tokenSha256)).toBeNull();
        expect(await file.lookup(second.line.tokenSha256)).toEqual({handle: 'hugo'});
        write(path, ['{broken'], 1_000_002);
        file.reload();
        expect(await file.lookup(second.line.tokenSha256)).toEqual({handle: 'hugo'});
        expect(logged.map((line) => (JSON.parse(line) as {event: string}).event)).toEqual(['members-reloaded', 'members-invalid']);
        expect(logged.join('\n')).not.toMatch(/hugo|damien|plm_/);
        expect(() => new MembersFile({path: join(directory, 'missing.jsonl')})).toThrow(MembersFileError);
    });
});

describe('relay with personal tokens', () => {
    test('test_rooms_and_participants_name_the_member_whose_token_created_or_joined_them', async () => {
        const path = join(directory, 'relay.jsonl');
        const damien = await issueMemberToken('damien', 'Damien');
        const hugo = await issueMemberToken('hugo');
        write(path, [damien.line, hugo.line], 2_000_000);
        const relay = await startServer({port: 0, dataFile: join(directory, 'members.sqlite'), createToken: 'team-secret', members: {file: path}, discovery: {loginMode: 'token', name: 'Team'}});
        try {
            const post = (path: string, body: unknown, token?: string) => fetch(`${relay.url}${path}`, {method: 'POST', headers: {'content-type': 'application/json', ...(token ? {'x-pairlobby-account-token': token} : {}), 'x-pairlobby-member': 'mallory'}, body: JSON.stringify(body)});
            const room = (token?: string) => post('/v1/rooms', {name: 'members', displayName: 'damien', kind: 'human', controllerCredential: newCredential('controller'), participantCredential: newCredential('participant')}, token);
            const join = (code: string, token?: string) => post('/v1/invites/redeem', {code, displayName: 'agent', kind: 'agent', attemptId: newId('attempt'), attemptSecret: 's'.repeat(32), participantCredential: newCredential('participant')}, token);

            const created = (await (await room(damien.token)).json()) as RoomBody;
            expect(created.room.owner).toBe('damien');
            expect(created.room.participants[0]?.member).toBe('damien');
            const joined = (await (await join(created.invite.code, hugo.token)).json()) as RoomBody;
            expect(joined.room.participants.find((participant) => participant.participantId === joined.participantId)?.member).toBe('hugo');

            const team = (await (await room('team-secret')).json()) as RoomBody;
            expect(team.room.owner).toBeUndefined();
            const guest = (await (await join(team.invite.code)).json()) as RoomBody;
            expect(guest.room.participants.every((participant) => participant.member === undefined)).toBe(true);

            const account = await fetch(`${relay.url}/api/online/account`, {headers: {'x-pairlobby-account-token': damien.token}});
            expect(await account.json()).toEqual({email: null, userId: 'member:damien', name: 'Team', server: relay.url, handle: 'damien'});
            const discovery = (await (await fetch(`${relay.url}/.well-known/pairlobby.json`)).json()) as {login: {members?: boolean}};
            expect(discovery.login.members).toBe(true);

            write(path, [hugo.line], 2_000_001);
            relay.reloadMembers();
            expect((await room(damien.token)).status).toBe(401);
            expect((await fetch(`${relay.url}/api/online/account`, {headers: {'x-pairlobby-account-token': damien.token}})).status).toBe(401);
            expect((await room(hugo.token)).status).toBe(201);
        } finally {
            await relay.close();
        }
    });

    test('test_a_members_file_needs_token_login_and_token_login_needs_some_token', async () => {
        const path = join(directory, 'needs.jsonl');
        write(path, [(await issueMemberToken('damien')).line], 3_000_000);
        await expect(startServer({port: 0, dataFile: join(directory, 'needs-1.sqlite'), members: {file: path}})).rejects.toThrow('a members file needs token-mode login');
        const membersOnly = await startServer({port: 0, dataFile: join(directory, 'needs-2.sqlite'), members: {file: path}, discovery: {loginMode: 'token'}});
        try {
            expect((await fetch(`${membersOnly.url}/v1/rooms`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).status).toBe(401);
        } finally {
            await membersOnly.close();
        }
    });
});

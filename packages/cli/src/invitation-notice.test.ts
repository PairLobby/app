import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, expect, test, vi} from 'vitest';
import {LocalStore} from '@pairlobby/client';

import {invitationNotice, readInvitationNotice, rememberInvitations, scheduleInvitationCheck} from './invitation-notice.js';
import type {ReceivedInvitation} from './online.js';

const directories: string[] = [];

afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

function store(): LocalStore {
    const path = mkdtempSync(join(tmpdir(), 'pairlobby-invitation-notice-'));
    directories.push(path);
    return new LocalStore(path);
}

function invitation(roomName: string, invitedBy = '@maria'): ReceivedInvitation {
    return {id: roomName, roomId: `rm_${roomName}`, roomName, invitedBy, role: 'member', agents: 1, createdAt: 1, expiresAt: 2};
}

test('test_the_reminder_names_the_room_and_who_asked_and_clears_once_answered', () => {
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', 'https://pairlobby.test');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', 'device-token');
    const local = store();
    expect(invitationNotice(local)).toBeNull();
    rememberInvitations(local, [invitation('Design review')], 1000);
    expect(readInvitationNotice(local)).toEqual({checkedAt: 1000, waiting: [{roomName: 'Design review', invitedBy: '@maria'}]});
    expect(invitationNotice(local)).toBe('@maria invited you to Design review: pairlobby invitations');
    rememberInvitations(local, [invitation('Design review'), invitation('Planning', '@joe')]);
    expect(invitationNotice(local)).toBe('2 invitations are waiting, including Design review from @maria: pairlobby invitations');
    rememberInvitations(local, []);
    expect(invitationNotice(local)).toBeNull();
});

test('test_a_logged_out_device_is_never_reminded_and_never_asks', () => {
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', 'https://pairlobby.test');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', undefined);
    vi.stubEnv('PAIRLOBBY_NO_UPDATE_CHECK', undefined);
    vi.stubEnv('CI', undefined);
    const local = store();
    rememberInvitations(local, [invitation('Design review')], 1000);
    expect(invitationNotice(local)).toBeNull();
    scheduleInvitationCheck(local, 'list', 10_000_000);
    expect(readInvitationNotice(local).checkedAt).toBe(1000);
});

test('test_checks_are_skipped_when_fresh_switched_off_or_for_commands_that_must_not_ask', () => {
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', 'https://pairlobby.test');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', 'device-token');
    vi.stubEnv('CI', undefined);
    vi.stubEnv('PAIRLOBBY_NO_UPDATE_CHECK', '1');
    const local = store();
    rememberInvitations(local, [], 1000);
    scheduleInvitationCheck(local, 'list', 10_000_000);
    expect(readInvitationNotice(local).checkedAt).toBe(1000);
    vi.stubEnv('PAIRLOBBY_NO_UPDATE_CHECK', undefined);
    scheduleInvitationCheck(local, 'invitations', 10_000_000);
    scheduleInvitationCheck(local, 'receiver-run', 10_000_000);
    scheduleInvitationCheck(local, 'list', 1000 + 9 * 60_000);
    expect(readInvitationNotice(local).checkedAt).toBe(1000);
});

//! A one-line reminder that an invitation is waiting, shown after other commands.
//!
//! Like the update notice, the question is asked in a detached process so no
//! command waits on the network: this file remembers the last answer, and the
//! reminder is printed from that. Only a logged-in device ever asks.

import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import type {LocalStore} from '@pairlobby/client';

import {accountToken} from './online.js';
import type {ReceivedInvitation} from './online.js';

export type InvitationNoticeState = {
    checkedAt: number;
    /** Room names and who asked, for the unanswered invitations seen at the last check. */
    waiting: {roomName: string; invitedBy: string}[];
};

const CHECK_INTERVAL_MS = 10 * 60_000;
const NEVER_CHECK = new Set(['invitations', 'update', 'receiver-run', 'receiver-tools', 'channel', 'guard-stop', 'serve']);

function stateFile(store: LocalStore): string {
    return join(store.directory, 'invitations.json');
}

export function readInvitationNotice(store: LocalStore): InvitationNoticeState {
    try {
        const saved = JSON.parse(readFileSync(stateFile(store), 'utf8')) as Partial<InvitationNoticeState>;
        return {checkedAt: typeof saved.checkedAt === 'number' ? saved.checkedAt : 0, waiting: Array.isArray(saved.waiting) ? saved.waiting : []};
    } catch {
        return {checkedAt: 0, waiting: []};
    }
}

/** Records what is waiting now. Called by the background check, and by `pairlobby invitations` whenever it has a fresh list. */
export function rememberInvitations(store: LocalStore, invitations: ReceivedInvitation[], now = Date.now()): void {
    writeState(store, {checkedAt: now, waiting: invitations.map((invitation) => ({roomName: invitation.roomName, invitedBy: invitation.invitedBy}))});
}

function writeState(store: LocalStore, state: InvitationNoticeState): void {
    mkdirSync(store.directory, {recursive: true, mode: 0o700});
    const temporary = `${stateFile(store)}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
    renameSync(temporary, stateFile(store));
}

function loggedIn(store: LocalStore): boolean {
    try {
        return Boolean(accountToken(store));
    } catch {
        return false;
    }
}

/** Starts a detached check when the last one is stale. Honors the same switches as update checks. */
export function scheduleInvitationCheck(store: LocalStore, command: string, now = Date.now()): void {
    if (NEVER_CHECK.has(command) || process.env['PAIRLOBBY_NO_UPDATE_CHECK'] === '1' || process.env['CI'] || !loggedIn(store)) {
        return;
    }
    const state = readInvitationNotice(store);
    if (now - state.checkedAt < CHECK_INTERVAL_MS) {
        return;
    }
    // Record the attempt first, so a burst of commands starts one check rather than one each.
    writeState(store, {...state, checkedAt: now});
    try {
        const child = spawn(process.execPath, [process.argv[1]!, 'invitations', '--background'], {detached: true, stdio: 'ignore', env: {...process.env, PAIRLOBBY_DATA_DIR: store.directory}});
        child.on('error', () => {});
        child.unref();
    } catch {
        // A reminder is never worth failing the command it rode along with.
    }
}

/** The line to show, or null when nothing is waiting or this device is logged out. */
export function invitationNotice(store: LocalStore): string | null {
    if (!loggedIn(store)) {
        return null;
    }
    const {waiting} = readInvitationNotice(store);
    if (waiting.length === 0) {
        return null;
    }
    const first = waiting[0]!;
    const what = waiting.length === 1 ? `${first.invitedBy} invited you to ${first.roomName}` : `${waiting.length} invitations are waiting, including ${first.roomName} from ${first.invitedBy}`;
    return `${what}: pairlobby invitations`;
}

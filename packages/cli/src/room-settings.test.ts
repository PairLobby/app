import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test, vi} from 'vitest';
import {DEFAULT_ROOM_POLICY} from '@pairlobby/protocol';
import type {RoomSnapshot} from '@pairlobby/protocol';
import {PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {settingsPage, statusPage} from './room-settings.js';
import type {RoomPanelPage, PanelEdit} from './room-panel.js';

function editor(page: RoomPanelPage, id: string): PanelEdit {
    const action = page.rows.find((row) => row.id === id)?.action;
    if (action?.kind !== 'edit') {
        throw new Error(`No editor for ${id}`);
    }
    return action;
}

test('hosted settings keep guest access read-only and separate privacy toggles from allowlist replacement', async () => {
    const client = new PairLobbyClient('https://example.invalid/relay/workspace');
    const room: RoomSnapshot = {roomId: 'room', name: 'Hosted', lifecycle: 'open', createdAt: 1, expiresAt: null, closedAt: null, controlRevision: 0, latestSeq: 0, earliestSeq: 0, groupTurnsSupported: true, turnMode: 'sequential', policy: DEFAULT_ROOM_POLICY, participants: [{participantId: 'owner', displayName: 'Owner', kind: 'human', role: 'member', capabilities: null, joinedAt: 1, revoked: false, left: false, paused: false, controlRevision: 0, acknowledgedOutcome: null}]};
    vi.spyOn(client, 'snapshot').mockResolvedValue(room);
    const privacy = vi.spyOn(client, 'accountRestrictions').mockResolvedValue({private: true, accounts: ['owner', 'allowed-member'], preserveAllowlistSupported: true});
    const save = vi.spyOn(client, 'setAccountRestrictions').mockResolvedValue({ok: true});
    const context = {client, roomId: room.roomId, participantId: 'owner', credential: 'member-token', controllerCredential: 'owner-token'};
    const page = await settingsPage(context);
    expect(page.rows.find((row) => row.id === 'privacy')?.action).toBeUndefined();
    await editor(page, 'hosted-privacy').save('open');
    expect(save).toHaveBeenLastCalledWith('room', 'owner-token', false);
    await editor(page, 'allowed-accounts').save('one@example.com, two@example.com');
    expect(save).toHaveBeenLastCalledWith('room', 'owner-token', true, ['one@example.com', 'two@example.com']);
    privacy.mockResolvedValue({private: true, accounts: ['owner']});
    expect((await settingsPage(context)).rows.find((row) => row.id === 'hosted-privacy')?.action).toBeUndefined();
});

test('room settings edit the relay, respect permission changes, and status is read-only and structured', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-room-settings-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const created = await client.createRoom('Settings room', {displayName: 'Owner', kind: 'human'});
    const member = await client.redeemInvite(created.invite.code, {displayName: 'Member', kind: 'human'});
    const owner = {client, roomId: created.roomId, credential: created.participantCredential, participantId: created.participantId, controllerCredential: created.controllerCredential};
    const other = {client, roomId: created.roomId, credential: member.participantCredential, participantId: member.participantId};
    try {
        const first = await settingsPage(owner);
        await editor(first, 'turns').save('parallel');
        await editor(first, 'expiry').save('in 2 hours');
        await editor(first, 'privacy').save('open_to_guests');
        await editor(first, 'lock').save('locked');
        await editor(first, 'name').save('Renamed room');
        const state = await client.snapshot(created.roomId, created.participantCredential);
        expect(state).toMatchObject({name: 'Renamed room', turnMode: 'parallel', locked: true, policy: {joinPolicy: 'open_to_guests'}});
        expect(state.expiresAt).toBeGreaterThan(Date.now() + 7_000_000);
        await expect(editor(first, 'expiry').save('at 2000-01-01')).rejects.toThrow('future');
        expect((await settingsPage(other)).rows.find((row) => row.id === 'turns')?.action).toBeUndefined();
        await client.setRole(created.roomId, created.controllerCredential, member.participantId, 'controller');
        const delegated = await settingsPage(other);
        await editor(delegated, 'lock').save('unlocked');
        expect((await client.snapshot(created.roomId, created.participantCredential)).locked).toBe(false);
        await client.setRole(created.roomId, created.controllerCredential, member.participantId, 'member');
        await expect(editor(delegated, 'turns').save('sequential')).rejects.toMatchObject({code: 'unauthorized'});
        const before = (await client.snapshot(created.roomId, created.participantCredential)).latestSeq;
        const status = await statusPage(owner);
        expect(status.rows.every((row) => !row.action)).toBe(true);
        expect(new Set(status.rows.map((row) => row.section))).toEqual(new Set(['Room', 'Messages', 'Members', 'Activity', 'Dates']));
        expect(status.rows.find((row) => row.id === 'messages')?.value).toBe('0');
        expect((await client.snapshot(created.roomId, created.participantCredential)).latestSeq).toBe(before);
    } finally {
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

test('test_auto_close_is_a_lifecycle_setting_with_presets_custom_values_and_an_immediate_close_warning', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-room-auto-close-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const created = await client.createRoom('Lifecycle room', {displayName: 'Owner', kind: 'human'});
    const member = await client.redeemInvite(created.invite.code, {displayName: 'Member', kind: 'human'});
    const owner = {client, roomId: created.roomId, credential: created.participantCredential, participantId: created.participantId, controllerCredential: created.controllerCredential};
    const other = {client, roomId: created.roomId, credential: member.participantCredential, participantId: member.participantId};
    try {
        const page = await settingsPage(owner);
        const row = page.rows.find((candidate) => candidate.id === 'auto-close')!;
        expect(row).toMatchObject({section: 'Lifecycle', value: 'Off'});
        const autoClose = editor(page, 'auto-close');
        expect(autoClose.choices?.map((choice) => choice.value)).toContain('agents-and-guests-left');
        expect(autoClose.choices?.at(-1)?.custom).toBe(true);
        expect(autoClose.confirm!('idle:24h')).toContain('Set auto-close');
        await autoClose.save('idle:90m');
        const updated = await settingsPage(owner);
        expect(updated.rows.find((candidate) => candidate.id === 'auto-close')?.value).toMatch(/^After 90 minutes without messages · closes /);
        // The room is younger than a minute here, so nothing is overdue yet; age:1m from a minute ago would be.
        expect(editor(updated, 'auto-close').confirm!('age:1m')).not.toContain('immediately');
        expect((await settingsPage(other)).rows.find((candidate) => candidate.id === 'auto-close')?.action).toBeUndefined();
        const status = await statusPage(owner);
        expect(status.rows.find((candidate) => candidate.id === 'auto-close')?.value).toBe('After 90 minutes without messages');
        expect(status.rows.find((candidate) => candidate.id === 'auto-close-at')?.value).not.toBe('Not scheduled');
        await expect(autoClose.save('idle:5s')).rejects.toThrow('one minute');
    } finally {
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

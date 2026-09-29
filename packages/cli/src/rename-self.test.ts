import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';

const execute = promisify(execFile);

test('rename-self changes only the selected membership, preserves defaults, and respects room permissions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-rename-self-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const api = new PairLobbyClient(relay.url);
    const room = await api.createRoom('Keep room name', {displayName: 'owner', kind: 'human'});
    const member = await api.redeemInvite(room.invite.code, {displayName: 'claude', kind: 'agent'});
    const store = new LocalStore(join(directory, 'device'));
    const ownerSession = newId('session');
    const agentSession = newId('session');
    store.upsertRoom({roomId: room.roomId, name: room.room.name, serverUrl: relay.url, createdAt: room.room.createdAt, expiresAt: null, controls: false, sessions: []});
    store.setProfile({displayName: 'Keep profile name', kind: 'human'});
    for (const identity of [{sessionId: ownerSession, participantId: room.participantId, credential: room.participantCredential, name: 'owner', kind: 'human' as const}, {sessionId: agentSession, participantId: member.participantId, credential: member.participantCredential, name: 'claude', kind: 'agent' as const}]) {
        store.addSession(room.roomId, {sessionId: identity.sessionId, participantId: identity.participantId, displayName: identity.name, kind: identity.kind, role: 'member', joinedAt: room.room.createdAt, lastReadSeq: 0, cwd: directory});
        store.putCredential(room.roomId, identity.sessionId, identity.credential);
    }
    const run = (args: string[]) => execute(process.execPath, [process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js'), 'rename-self', ...args, '--room', room.roomId, '--json'], {env: {...process.env, PAIRLOBBY_DATA_DIR: store.directory, PAIRLOBBY_ROOM: '', PAIRLOBBY_SESSION: ''}, timeout: 5000});
    try {
        await expect(run(['Ambiguous'])).rejects.toThrow('session');
        const result = JSON.parse((await run(['Claude terminal', '--session', agentSession])).stdout);
        expect(result).toEqual({roomId: room.roomId, sessionId: agentSession, participantId: member.participantId, displayName: 'Claude terminal', nameSource: 'room'});
        const snapshot = await api.snapshot(room.roomId, room.participantCredential);
        expect(snapshot.name).toBe('Keep room name');
        expect(snapshot.participants.find((person) => person.participantId === member.participantId)).toMatchObject({displayName: 'Claude terminal', nameSource: 'room'});
        expect(snapshot.participants.find((person) => person.participantId === room.participantId)?.displayName).toBe('owner');
        const saved = new LocalStore(store.directory);
        expect(saved.room(room.roomId)?.sessions.find((session) => session.sessionId === agentSession)?.displayName).toBe('Claude terminal');
        expect(saved.profile().displayName).toBe('Keep profile name');
        await expect(run(['all', '--session', agentSession])).rejects.toThrow('reserved');
        await expect(run(['--session', agentSession])).rejects.toThrow('Usage:');
        await api.setMuted(room.roomId, room.controllerCredential, member.participantId, true);
        await expect(run(['Blocked', '--session', agentSession])).rejects.toThrow('muted');
    } finally {
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
});

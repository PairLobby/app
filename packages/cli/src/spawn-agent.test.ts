import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';
import {spawnAgent, runAgentCommand} from './spawn-agent.js';
import type {SpawnContext, SpawnDependencies} from './spawn-agent.js';

type Relay = Awaited<ReturnType<typeof startServer>>;
let directory: string, relay: Relay, client: PairLobbyClient, context: SpawnContext, credential: string, controller: string;
const dependencies: SpawnDependencies = {preflight: async () => process.execPath, start: async () => ({pid: process.pid, runtime: 'codex', state: 'available'})};

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-spawn-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'room.sqlite')});
    client = new PairLobbyClient(relay.url);
    const human = newId('session');
    const created = await client.createRoom('spawn tests', {displayName: 'human', kind: 'human', sessionId: human});
    credential = created.participantCredential;
    controller = created.controllerCredential;
    const store = new LocalStore(join(directory, 'device'));
    store.upsertRoom({roomId: created.roomId, name: created.room.name, serverUrl: relay.url, createdAt: created.room.createdAt, expiresAt: created.room.expiresAt, controls: true, sessions: [{participantId: created.participantId, sessionId: human, displayName: 'human', kind: 'human', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory}]});
    store.putCredential(created.roomId, human, credential);
    context = {store, roomId: created.roomId, sessionId: human};
});

afterEach(async () => {
    vi.restoreAllMocks();
    client.closeLive();
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

test('simultaneous local spawns have distinct names/identities and preserve the human profile', async () => {
    context.store.setProfile({displayName: 'human', kind: 'human'});
    context.store.rememberHumanSession(context.roomId, context.sessionId);
    const values = await Promise.all([spawnAgent(context, {runtime: 'codex'}, dependencies), spawnAgent(context, {runtime: 'codex'}, dependencies)]);
    expect(values.map((value) => value.name).sort()).toEqual(['codex', 'codex-2']);
    expect(new Set(values.map((value) => value.sessionId)).size).toBe(2);
    expect(context.store.room(context.roomId)?.preferredHumanSessionId).toBe(context.sessionId);
    expect(context.store.profile()).toEqual({displayName: 'human', kind: 'human'});
    expect((await client.snapshot(context.roomId, credential)).participants.filter((member) => member.kind === 'agent').every((member) => member.role === 'member')).toBe(true);
    expect((await client.readEvents(context.roomId, credential, 0, 100)).events.filter((event) => event.type === 'message')).toEqual([]);
    await expect(spawnAgent(context, {runtime: 'codex', name: 'CODEX'}, dependencies)).rejects.toThrow('already named');
    const resumed = await spawnAgent(context, {resume: values[0]!.operationId}, dependencies);
    expect(resumed.sessionId).toBe(values[0]!.sessionId);
    expect((await client.snapshot(context.roomId, credential)).participants).toHaveLength(3);
    expect(await runAgentCommand('/agents', context)).toContain('codex-2');
});

test('lost redemption response resumes the original membership, even from another LocalStore instance', async () => {
    const redeem = PairLobbyClient.prototype.redeemInvite;
    const spy = vi.spyOn(PairLobbyClient.prototype, 'redeemInvite').mockImplementationOnce(async function(this: PairLobbyClient, ...args) {
        await redeem.apply(this, args);
        throw new Error('simulated response lost');
    });
    const error = await spawnAgent(context, {runtime: 'claude', model: 'chosen', effort: 'high', workdir: directory}, dependencies).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    const id = (error as Error).message.match(/Spawn operation (at_[A-Z0-9]+)/)![1]!;
    spy.mockRestore();
    const result = await spawnAgent({...context, store: new LocalStore(context.store.directory)}, {resume: id}, dependencies);
    expect(result).toMatchObject({name: 'claude', model: 'chosen', effort: 'high'});
    expect((await client.snapshot(context.roomId, credential)).participants).toHaveLength(2);
});

test('startup failure removes the active membership and records a terminal rollback', async () => {
    await expect(spawnAgent(context, {runtime: 'codex'}, {...dependencies, start: async () => { throw new Error('startup broken'); }})).rejects.toThrow('startup broken');
    const snapshot = await client.snapshot(context.roomId, credential);
    expect(snapshot.participants.filter((member) => !member.left)).toHaveLength(1);
    expect(await runAgentCommand('/agents', context)).toContain('No agents currently');
    expect((await spawnAgent(context, {runtime: 'codex'}, dependencies)).name).toBe('codex');
});

test('cleanup failure is recoverable and does not create another participant', async () => {
    const leave = vi.spyOn(PairLobbyClient.prototype, 'leave').mockRejectedValueOnce(new Error('offline during cleanup'));
    const error = await spawnAgent(context, {runtime: 'codex'}, {...dependencies, start: async () => { throw new Error('startup failed'); }}).catch((value: Error) => value);
    const id = (error as Error).message.match(/Spawn operation (at_[A-Z0-9]+)/)![1]!;
    leave.mockRestore();
    await expect(spawnAgent(context, {resume: id}, dependencies)).rejects.toThrow('cleanup completed');
    expect((await client.snapshot(context.roomId, credential)).participants.filter((member) => !member.left)).toHaveLength(1);
});

test('locked rooms, missing runtimes, muted members, and agent callers do not gain admission', async () => {
    await expect(spawnAgent(context, {runtime: 'codex'}, {...dependencies, preflight: async () => { throw new Error('runtime missing'); }})).rejects.toThrow('runtime missing');
    await client.setLocked(context.roomId, controller, true);
    await expect(spawnAgent(context, {runtime: 'codex'}, dependencies)).rejects.toThrow();
    expect((await client.snapshot(context.roomId, credential)).participants).toHaveLength(1);
    await client.setLocked(context.roomId, controller, false);
    const result = await spawnAgent(context, {runtime: 'codex'}, dependencies);
    await expect(spawnAgent({...context, sessionId: result.sessionId}, {runtime: 'claude'}, dependencies)).rejects.toThrow('human member');
    const human = context.store.room(context.roomId)!.sessions.find((entry) => entry.sessionId === context.sessionId)!;
    await client.setMuted(context.roomId, controller, human.participantId, true);
    await expect(spawnAgent(context, {runtime: 'qwen'}, dependencies)).rejects.toThrow('human member');
});

test('commands validate options without broadcasting and cannot adopt another local agent', async () => {
    expect(await runAgentCommand('/codex --help', context)).toContain('/spawn');
    await expect(runAgentCommand('/qwen --effort high', context)).rejects.toThrow('not supported');
    await expect(runAgentCommand('/agent stop unknown', context)).rejects.toThrow('unambiguous');
    expect((await client.snapshot(context.roomId, credential)).participants).toHaveLength(1);
});

test('hosted-origin admission carries the saved account token without exposing it in results', async () => {
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', relay.url);
    context.store.putCredential('online-account', relay.url, 'fixture-account-token');
    const fetch = globalThis.fetch;
    const tokens: (string | null)[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input).endsWith('/v1/invites/redeem')) {
            tokens.push(new Headers(init?.headers).get('x-pairlobby-account-token'));
        }
        return fetch(input, init);
    });
    try {
        const result = await spawnAgent(context, {runtime: 'codex'}, dependencies);
        expect(tokens).toHaveLength(1);
        expect(tokens.every((token) => token === 'fixture-account-token')).toBe(true);
        expect(JSON.stringify(result)).not.toContain('fixture-account-token');
        expect(JSON.stringify(result)).not.toContain('participantCredential');
    } finally {
        vi.unstubAllEnvs();
    }
});

test('a guest cannot spawn and another human cannot resume or control someone else\'s agent', async () => {
    const first = await spawnAgent(context, {runtime: 'codex'}, dependencies);
    for (const role of ['guest', 'member'] as const) {
        const invite = await client.mintInvite(context.roomId, credential, role);
        const sessionId = newId('session');
        const joined = await client.redeemInvite(invite.code, {displayName: role, kind: 'human', sessionId});
        context.store.putCredential(context.roomId, sessionId, joined.participantCredential);
        context.store.addSession(context.roomId, {participantId: joined.participantId, sessionId, displayName: role, kind: 'human', role, joinedAt: Date.now(), lastReadSeq: 0, cwd: directory});
        const other = {...context, sessionId};
        if (role === 'guest') {
            await expect(spawnAgent(other, {runtime: 'qwen'}, dependencies)).rejects.toThrow('human member');
        } else {
            await expect(spawnAgent(other, {resume: first.operationId}, dependencies)).rejects.toThrow('belongs to this human');
            await expect(runAgentCommand('/agent stop codex', other)).rejects.toThrow('unambiguous');
        }
    }
});

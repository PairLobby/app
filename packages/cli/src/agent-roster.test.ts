import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import type {JoinedRoom} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';
import {loadAgentRoster, plainCell, agentProvider, formatAgentRoster} from './agent-roster.js';
import type {AgentRosterContext} from './agent-roster.js';
import {spawnAgent} from './spawn-agent.js';

type Relay = Awaited<ReturnType<typeof startServer>>;
let directory: string, relay: Relay, client: PairLobbyClient, context: AgentRosterContext, credential: string, controller: string;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-roster-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'room.sqlite')});
    client = new PairLobbyClient(relay.url);
    const created = await client.createRoom('roster', {displayName: 'human', kind: 'human'});
    credential = created.participantCredential;
    controller = created.controllerCredential;
    const store = new LocalStore(join(directory, 'device'));
    const sessionId = newId('session');
    store.upsertRoom({roomId: created.roomId, name: 'roster', serverUrl: relay.url, createdAt: created.room.createdAt, expiresAt: null, controls: true, sessions: [{participantId: created.participantId, sessionId, displayName: 'human', kind: 'human', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory}]});
    store.putCredential(created.roomId, sessionId, credential);
    context = {store, roomId: created.roomId, sessionId};
});
afterEach(async () => {
    vi.restoreAllMocks();
    client.closeLive();
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

async function joinAgent(name: string, local = false, spawnedBy?: string): Promise<JoinedRoom> {
    const invite = await client.mintInvite(context.roomId, credential);
    const sessionId = newId('session');
    const agent = await client.redeemInvite(invite.code, {displayName: name, kind: 'agent', sessionId, capabilities: {runtime: 'qwen', deliverUnsolicited: false, cancelTurn: false, cancelTool: false}});
    if (local) {
        context.store.addSession(context.roomId, {participantId: agent.participantId, sessionId, displayName: name, kind: 'agent', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory, runtime: 'qwen', conversationId: 'external-conversation', ...(spawnedBy ? {spawnedBy} : {})});
        context.store.putSessionInvite(context.roomId, sessionId, invite.code);
    }
    return agent;
}

test('lists all current agents by identity, including external agents, and distinguishes origin without exposing credentials', async () => {
    const external = await joinAgent('same-name');
    const local = await joinAgent('same-name', true);
    const other = await joinAgent('other', true, newId('session'));
    const own = await spawnAgent(context, {runtime: 'codex', model: 'configured-model'}, {preflight: async () => process.execPath, start: async () => ({pid: process.pid, state: 'available', runtime: 'codex'})});
    const roster = await loadAgentRoster(context);
    expect(roster.rows).toHaveLength(4);
    expect(roster.rows.find((row) => row.participantId === external.participantId)).toMatchObject({origin: 'Joined externally', provider: 'Qwen', status: 'Joined (unverified)', model: 'Not shared', conversationId: 'Not shared', invite: 'Not shared'});
    const localRow = roster.rows.find((row) => row.participantId === local.participantId)!;
    expect(localRow).toMatchObject({origin: 'Joined externally', conversationId: 'external-conversation', model: 'Unknown'});
    expect(localRow.invite).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(readFileSync(join(context.store.directory, 'rooms.json'), 'utf8')).not.toContain(localRow.invite);
    expect(roster.rows.find((row) => row.participantId === other.participantId)?.origin).toBe('Other session');
    expect(roster.rows.find((row) => row.participantId === own.participantId)).toMatchObject({origin: 'This session', provider: 'OpenAI', model: 'configured-model', configuredModel: true, conversationId: 'Not started'});
    expect(formatAgentRoster(roster)).toContain('Conversation ID');
    expect(JSON.stringify(roster)).not.toContain(credential);
    await client.leave(context.roomId, external.participantCredential);
    expect((await loadAgentRoster(context)).rows).toHaveLength(3);
});

test('reads last sent message dates across byte-limited pages without acknowledgements or cursor changes', async () => {
    const first = await joinAgent('first');
    const second = await joinAgent('second');
    const old = await client.send(context.roomId, first.participantCredential, {type: 'message', payload: {text: 'Old message', priority: 'normal'}, idempotencyKey: newId('event')});
    await client.send(context.roomId, second.participantCredential, {type: 'message', payload: {text: 'Another message', priority: 'normal'}, idempotencyKey: newId('event')});
    const latest = await client.send(context.roomId, first.participantCredential, {type: 'message', payload: {text: 'Latest message', priority: 'normal'}, idempotencyKey: newId('event')});
    const snapshot = await client.snapshot(context.roomId, credential);
    const read = PairLobbyClient.prototype.readEvents;
    vi.spyOn(PairLobbyClient.prototype, 'readEvents').mockImplementation(function(this: PairLobbyClient, room, token, after) { return read.call(this, room, token, after, 1); });
    const roster = await loadAgentRoster(context);
    expect(roster.rows.find((row) => row.participantId === first.participantId)?.lastMessage).toBe(new Date(latest.event.at).toISOString());
    expect(roster.rows.every((row) => row.lastMessage !== 'None retained')).toBe(true);
    expect(context.store.room(context.roomId)!.sessions[0]!.lastReadSeq).toBe(0);
    expect((await client.snapshot(context.roomId, credential)).latestSeq).toBe(snapshot.latestSeq);
    expect(old.event.at).toBeLessThanOrEqual(latest.event.at);
});

test('prefers the managed conversation and reported model; stopped is not misrepresented as online', async () => {
    const joined = await joinAgent('managed', true, context.sessionId);
    const local = context.store.room(context.roomId)!.sessions.find((session) => session.participantId === joined.participantId)!;
    const path = join(context.store.directory, 'receivers', local.sessionId);
    mkdirSync(path, {recursive: true});
    writeFileSync(join(path, 'config.json'), JSON.stringify({runtime: 'qwen', cwd: directory, model: 'requested-model'}));
    writeFileSync(join(path, 'status.json'), JSON.stringify({pid: 0, state: 'stopped', runtime: 'qwen', threadId: 'managed-conversation', model: 'reported-model'}));
    const row = (await loadAgentRoster(context)).rows[0]!;
    expect(row).toMatchObject({status: 'Stopped', conversationId: 'managed-conversation', model: 'reported-model', configuredModel: false});
    expect(row.conversationId).not.toBe(local.conversationId);
});

test('only an explicit working declaration produces Working, and local flags do not overrule room moderation', async () => {
    const agent = await joinAgent('remote');
    const request = await client.send(context.roomId, credential, {type: 'message', recipientId: agent.participantId, payload: {text: 'Work', priority: 'normal'}, idempotencyKey: newId('event')});
    const grant = await client.claimTurn(context.roomId, agent.participantCredential, request.event.eventId, newId('event'));
    expect((await loadAgentRoster(context)).rows[0]?.status).toBe('Turn claimed');
    await client.acknowledgeMessage(context.roomId, agent.participantCredential, request.event.eventId);
    await client.declareWorking(context.roomId, agent.participantCredential, request.event.eventId, grant.token!);
    expect((await loadAgentRoster(context)).rows[0]?.status).toBe('Working');
    await client.setMuted(context.roomId, controller, agent.participantId, true);
    expect((await loadAgentRoster(context)).rows[0]?.status).toBe('Muted');
});

test('unavailable history is explicit, and runtime names never come from display names', async () => {
    await joinAgent('claude', true);
    vi.spyOn(PairLobbyClient.prototype, 'readEvents').mockRejectedValue(new Error('history unavailable'));
    const roster = await loadAgentRoster(context);
    expect(roster.rows[0]).toMatchObject({provider: 'Qwen', lastMessage: 'Unavailable'});
    expect(agentProvider()).toBe('Unknown');
    expect(plainCell('\x1b[31mred\x1b[0m\nvalue')).toBe('red value');
});

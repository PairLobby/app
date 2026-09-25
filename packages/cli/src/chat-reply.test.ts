import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, expect, test, vi} from 'vitest';
import {PairLobbyClient} from '@pairlobby/client';
import {ProtocolError, newId} from '@pairlobby/protocol';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';
import {sendChatReply} from './chat-reply.js';
import {ReplyComposer, messageTarget} from './reply-composer.js';
import type {ReplySubmission} from './reply-composer.js';

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-replies-'));
let server: RunningServer;
let client: PairLobbyClient;
beforeAll(async () => {
    server = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
    client = new PairLobbyClient(server.url);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

test('a lost answer response retries the answer instead of creating a new follow-up', async () => {
    const room = await client.createRoom('reply', {displayName: 'human', kind: 'human'});
    const agent = await client.redeemInvite(room.invite.code, {displayName: 'agent', kind: 'agent'});
    const source = await client.send(room.roomId, agent.participantCredential, {type: 'message', recipientId: room.participantId, payload: {text: 'question', priority: 'normal'}, idempotencyKey: newId('event')});
    const submission: ReplySubmission = {target: messageTarget(source.event)!, text: 'answer'};
    const context = {client, roomId: room.roomId, credential: room.participantCredential, participantId: room.participantId, quotedMessagesSupported: true};
    const reply = client.reply.bind(client);
    vi.spyOn(client, 'reply').mockImplementationOnce(async (...args) => {
        await reply(...args);
        throw new ProtocolError('server_unavailable', 'response lost');
    });
    await expect(sendChatReply(submission, context)).rejects.toThrow('response lost');
    const composer = new ReplyComposer();
    composer.restore(submission);
    const retry = composer.submit('/reply answer')!;
    expect((await sendChatReply(retry, context)).deduplicated).toBe(true);
    expect((await client.readEvents(room.roomId, room.participantCredential, 0)).events.filter((event) => event.type === 'message')).toHaveLength(2);
});

test('a lost quoted follow-up retries the same key and passes the original text to the recipient', async () => {
    const room = await client.createRoom('followup', {displayName: 'human', kind: 'human'});
    const agent = await client.redeemInvite(room.invite.code, {displayName: 'agent', kind: 'agent'});
    const source = await client.send(room.roomId, agent.participantCredential, {type: 'message', payload: {text: 'original context', priority: 'normal'}, idempotencyKey: newId('event')});
    const submission: ReplySubmission = {target: messageTarget(source.event)!, text: 'explain'};
    const context = {client, roomId: room.roomId, credential: room.participantCredential, participantId: room.participantId, quotedMessagesSupported: true};
    const send = client.send.bind(client);
    vi.spyOn(client, 'send').mockImplementationOnce(async (...args) => {
        await send(...args);
        throw new ProtocolError('server_unavailable', 'response lost');
    });
    await expect(sendChatReply(submission, context)).rejects.toThrow('response lost');
    const retry = await sendChatReply(submission, context);
    expect(retry.deduplicated).toBe(true);
    expect(retry.event.quoteOf).toBe(source.event.eventId);
    const pending = await client.pendingRequests(room.roomId, agent.participantCredential);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toContain('original context');
    expect(pending[0]!.text).toContain('explain');
});

test('a lookup outage cannot turn an answer into an unrelated request', async () => {
    const lookup = vi.spyOn(client, 'request').mockRejectedValue(new ProtocolError('server_unavailable', 'offline'));
    const send = vi.spyOn(client, 'send');
    await expect(sendChatReply({target: {eventId: 'ev_test', senderId: 'pt_agent', text: 'question'}, text: 'answer'}, {client, roomId: 'rm_test', credential: 'test', participantId: 'pt_human', quotedMessagesSupported: true})).rejects.toThrow('offline');
    expect(lookup).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
});

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolve} from 'node:path';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {expect, test, vi} from 'vitest';
import {newCredential, newId, messageActionLabel} from '@pairlobby/protocol';
import type {MessageAction} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import {MemoryStore} from '@pairlobby/fixtures';
import {SqliteRoomStore, startServer} from '@pairlobby/local-server';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {ReceiptView} from '../src/receipt-view.js';
import {replyOutcome} from '../src/reply-wait.js';

test('installed CLI reports Read separately and retries an explicit answer link without duplicate replies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stages-cli-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const api = new PairLobbyClient(relay.url);
    const room = await api.createRoom('CLI stages', {displayName: 'user', kind: 'human'});
    const agent = await api.redeemInvite(room.invite.code, {displayName: 'worker', kind: 'agent'});
    const sessionId = newId('session');
    const local = new LocalStore(join(directory, 'device'));
    local.upsertRoom({roomId: room.roomId, name: 'CLI stages', serverUrl: relay.url, createdAt: Date.now(), expiresAt: null, controls: false, sessions: []});
    local.addSession(room.roomId, {sessionId, participantId: agent.participantId, displayName: 'worker', kind: 'agent', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory});
    local.putCredential(room.roomId, sessionId, agent.participantCredential);
    const execute = promisify(execFile);
    const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, [process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js'), ...args, '--room', room.roomId, '--session', sessionId, '--json'], {env: {...process.env, PAIRLOBBY_DATA_DIR: local.directory}, timeout: 10_000})).stdout);
    try {
        const ask = await api.send(room.roomId, room.participantCredential, {type: 'message', recipientId: agent.participantId, payload: {text: 'Please review', priority: 'normal'}, idempotencyKey: newId('event')});
        const watcher = spawn(process.execPath, [process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js'), 'watch', '--room', room.roomId, '--session', sessionId, '--after', String(ask.event.seq - 1), '--json'], {env: {...process.env, PAIRLOBBY_DATA_DIR: local.directory}, stdio: 'ignore'});
        try {
            await vi.waitFor(async () => expect((await api.request(room.roomId, room.participantCredential, ask.event.eventId)).receivedAt).not.toBeNull(), {timeout: 20_000});
        } finally {
            const stopped = new Promise<void>((done) => watcher.once('close', () => done()));
            watcher.kill('SIGTERM');
            await stopped;
        }
        expect((await api.request(room.roomId, room.participantCredential, ask.event.eventId)).readAt).toBeUndefined();
        expect(await cli('message-status', ask.event.eventId, 'read')).toMatchObject({state: 'read', furtherActionExpected: null});
        await api.deliveryFailed(room.roomId, agent.participantCredential, ask.event.eventId, 'Interrupted fixture', undefined, 'execution');
        const answer = await api.send(room.roomId, agent.participantCredential, {type: 'message', recipientId: room.participantId, payload: {text: 'My answer', priority: 'normal'}, idempotencyKey: newId('event')});
        expect(await cli('link-answer', ask.event.eventId, answer.event.eventId)).toMatchObject({state: 'done', furtherActionExpected: false});
        const sequence = (await api.snapshot(room.roomId, room.participantCredential)).latestSeq;
        await cli('link-answer', ask.event.eventId, answer.event.eventId);
        expect((await api.snapshot(room.roomId, room.participantCredential)).latestSeq).toBe(sequence);
        expect((await api.pendingRequests(room.roomId, room.participantCredential))).toHaveLength(0);
    } finally {
        api.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
    // Five CLI processes and a watcher: the default five seconds is not enough on a busy runner.
}, 60_000);

test('a request and the event that changed it carry one timestamp, so the newest state wins in the receipt view', async () => {
    // A clock that advances on every reading stands in for a loaded machine, where two readings in one operation differ.
    let tick = 1_700_000_000_000;
    const service = new RoomService(new MemoryStore(), () => tick++);
    const owner = newCredential('controller');
    const sender = newCredential('participant');
    const receiver = newCredential('participant');
    const room = await service.createRoom({name: 'clock', displayName: 'owner', kind: 'human', controllerCredential: owner, participantCredential: sender});
    const agent = await service.redeemInvite({code: (await service.mintInvite(room.roomId, owner, 'member')).code, displayName: 'worker', kind: 'agent', participantCredential: receiver, attemptId: newId('attempt')});
    const ask = await service.send(room.roomId, sender, {type: 'message', payload: {text: 'Do this', priority: 'normal'}, recipientId: agent.participantId, idempotencyKey: newId('event')});
    const id = ask.event.eventId;
    const working = await service.send(room.roomId, receiver, {type: 'message.received', payload: {eventId: id, stage: 'read', action: 'working'}, idempotencyKey: newId('event')});
    expect(await service.request(room.roomId, sender, id)).toMatchObject({readAt: working.event.at, actionAt: working.event.at});
    await service.send(room.roomId, receiver, {type: 'message.delivery_failed', payload: {eventId: id, reason: 'Process exited', stage: 'execution'}, idempotencyKey: newId('event')});
    const answer = await service.send(room.roomId, receiver, {type: 'message', payload: {text: 'Answer', priority: 'normal'}, recipientId: room.participantId, idempotencyKey: newId('event')});
    const done = await service.send(room.roomId, receiver, {type: 'message.received', payload: {eventId: id, stage: 'read', action: 'done', responseEventId: answer.event.eventId}, idempotencyKey: newId('event')});
    const recovered = await service.request(room.roomId, sender, id);
    expect(recovered).toMatchObject({actionAt: done.event.at, respondedAt: done.event.at});
    const view = new ReceiptView();
    for (const event of (await service.read(room.roomId, sender, 0, 500)).events) {
        view.observe(event);
    }
    view.observeRequest(recovered);
    expect(view.forParticipant(id, agent.participantId).action).toBe('Done · recovered');
});

test.each(['memory', 'sqlite'])('%s preserves independent received/read/actions and recovers an interrupted request with an explicit link', async (backend) => {
    const directory = mkdtempSync(join(tmpdir(), 'message-stages-'));
    const store = backend === 'memory' ? new MemoryStore() : new SqliteRoomStore(join(directory, 'room.sqlite'));
    let service = new RoomService(store);
    const owner = newCredential('controller');
    const sender = newCredential('participant');
    const receiver = newCredential('participant');
    const bystander = newCredential('participant');
    const room = await service.createRoom({name: 'stages', displayName: 'owner', kind: 'human', controllerCredential: owner, participantCredential: sender});
    const invite = await service.mintInvite(room.roomId, owner, 'member');
    const agent = await service.redeemInvite({code: invite.code, displayName: 'worker', kind: 'agent', participantCredential: receiver, attemptId: newId('attempt')});
    const anotherInvite = await service.mintInvite(room.roomId, owner, 'member');
    const other = await service.redeemInvite({code: anotherInvite.code, displayName: 'other', kind: 'agent', participantCredential: bystander, attemptId: newId('attempt')});
    const send = async (credential: string, text: string, recipientId?: string) => service.send(room.roomId, credential, {type: 'message', payload: {text, priority: 'normal'}, ...(recipientId ? {recipientId} : {}), idempotencyKey: newId('event')});
    const status = (credential: string, eventId: string, action?: MessageAction, reason?: string, responseEventId?: string) => service.send(room.roomId, credential, {type: 'message.received', payload: {eventId, stage: 'read', ...(action ? {action} : {}), ...(reason ? {reason} : {}), ...(responseEventId ? {responseEventId} : {})}, idempotencyKey: newId('event')});
    try {
        const ask = await send(sender, 'Do this', agent.participantId);
        const id = ask.event.eventId;
        await service.acknowledgeMessage(room.roomId, receiver, id);
        expect(await service.request(room.roomId, sender, id)).toMatchObject({receivedAt: expect.any(Number)});
        expect((await service.request(room.roomId, sender, id)).readAt).toBeUndefined();
        await status(receiver, id);
        const readAt = (await service.request(room.roomId, sender, id)).readAt;
        await status(receiver, id);
        expect((await service.request(room.roomId, sender, id)).readAt).toBe(readAt);
        await status(bystander, id, 'no_action', 'Not addressed to me');
        expect((await service.request(room.roomId, sender, id)).requiresReply).toBe(true);
        await expect(status(bystander, id, 'working')).rejects.toMatchObject({code: 'unauthorized'});
        await expect(status(receiver, id, 'waiting')).rejects.toMatchObject({code: 'invalid_request'});
        await status(receiver, id, 'working');
        await status(receiver, id, 'waiting', 'Waiting for review');
        expect(messageActionLabel(await service.request(room.roomId, sender, id))).toBe('Waiting · Waiting for review');
        await service.send(room.roomId, receiver, {type: 'message.delivery_failed', payload: {eventId: id, reason: 'Process exited', stage: 'execution'}, idempotencyKey: newId('event')});
        const answer = await send(receiver, 'Final answer posted separately', room.participantId);
        expect((await service.request(room.roomId, sender, id)).responseEventId).toBeNull();
        await expect(status(bystander, id, 'done', undefined, answer.event.eventId)).rejects.toMatchObject({code: 'unauthorized'});
        const wrong = await send(bystander, 'Someone else’s answer');
        await expect(status(receiver, id, 'done', undefined, wrong.event.eventId)).rejects.toMatchObject({code: 'invalid_request'});
        await status(receiver, id, 'done', undefined, answer.event.eventId);
        service = new RoomService(store);
        const recovered = await service.request(room.roomId, sender, id);
        expect(recovered).toMatchObject({responseEventId: answer.event.eventId, responseText: 'Final answer posted separately', failureStage: 'execution', failureAt: expect.any(Number), readAt});
        expect(messageActionLabel(recovered)).toBe('Done · recovered');
        expect((await service.requests(room.roomId, sender)).requests).toHaveLength(0);
        const view = new ReceiptView();
        for (const event of (await service.read(room.roomId, sender, 0, 500)).events) {
            view.observe(event);
        }
        view.observeRequest(recovered);
        expect(view.forParticipant(id, agent.participantId)).toMatchObject({readAt, action: 'Done · recovered'});
        expect(view.forParticipant(id, other.participantId).action).toBe('No action needed');
        const declined = await send(sender, 'Another task', agent.participantId);
        await status(receiver, declined.event.eventId, 'declined', 'Needs unavailable access');
        const outcome = await service.request(room.roomId, sender, declined.event.eventId);
        expect(outcome.requiresReply).toBe(false);
        expect(replyOutcome(outcome, room.participantId)).toMatchObject({state: 'declined', reason: 'Needs unavailable access'});
        await status(receiver, declined.event.eventId, 'declined', 'Needs unavailable access');
        await expect(status(receiver, declined.event.eventId, 'working')).rejects.toMatchObject({code: 'invalid_request'});
    } finally {
        if ('close' in store) {
            store.close();
        }
        rmSync(directory, {recursive: true, force: true});
    }
});

test('group stages require the current lease; no-action releases the slot and cancelled work cannot be revived', async () => {
    const service = new RoomService(new MemoryStore());
    const owner = newCredential('controller');
    const sender = newCredential('participant');
    const receiver = newCredential('participant');
    const room = await service.createRoom({name: 'group', displayName: 'owner', kind: 'human', controllerCredential: owner, participantCredential: sender});
    const invite = await service.mintInvite(room.roomId, owner, 'member');
    const agent = await service.redeemInvite({code: invite.code, displayName: 'worker', kind: 'agent', participantCredential: receiver, attemptId: newId('attempt')});
    const group = await service.send(room.roomId, sender, {type: 'message', recipientIds: [agent.participantId], payload: {text: 'Group request', priority: 'normal'}, idempotencyKey: newId('event')});
    const target = (await service.requests(room.roomId, sender)).requests[0]!;
    const change = (action: MessageAction, token?: string) => service.send(room.roomId, receiver, {type: 'message.received', payload: {eventId: target.eventId, stage: 'read', action, reason: 'Nothing to add'}, idempotencyKey: newId('event'), ...(token ? {turnToken: token} : {})});
    await expect(change('no_action')).rejects.toMatchObject({code: 'turn_required'});
    const grant = await service.turns.claim(room.roomId, receiver, target.eventId, newId('event'));
    await change('waiting', grant.token);
    expect((await service.turns.status(room.roomId, sender)).entries[0]?.state).toBe('waiting');
    await change('no_action', grant.token);
    expect((await service.request(room.roomId, sender, target.eventId)).requiresReply).toBe(false);
    expect((await service.turns.status(room.roomId, sender)).entries).toHaveLength(0);
    const events = (await service.read(room.roomId, sender, 0, 500)).events;
    expect(events.some((event) => event.type === 'message.received' && event.payload.eventId === group.event.eventId && event.payload.action === 'no_action')).toBe(true);
    await service.send(room.roomId, sender, {type: 'message', recipientIds: [agent.participantId], payload: {text: 'Cancel this request', priority: 'normal'}, idempotencyKey: newId('event')});
    const cancelled = (await service.requests(room.roomId, sender)).requests[0]!;
    await service.turns.control(room.roomId, owner, {action: 'cancel', requestId: cancelled.eventId});
    const late = await service.send(room.roomId, receiver, {type: 'message', payload: {text: 'Late unthreaded answer', priority: 'normal'}, idempotencyKey: newId('event')});
    await expect(service.send(room.roomId, receiver, {type: 'message.received', payload: {eventId: cancelled.eventId, stage: 'read', action: 'done', responseEventId: late.event.eventId}, idempotencyKey: newId('event')})).rejects.toMatchObject({code: 'invalid_request'});
});

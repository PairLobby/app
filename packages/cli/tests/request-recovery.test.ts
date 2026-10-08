import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

import {expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {messageActionLabel, newId} from '@pairlobby/protocol';

import {recoveryText} from '../src/request-recovery.js';

const execute = promisify(execFile);
type ListedRequest = {eventId: string; allowedActions: string[]};

test('test_request_retry_and_reassign_send_an_inspect_first_attempt_whose_answer_resolves_the_original', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-recovery-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite')});
    const api = new PairLobbyClient(relay.url);
    const room = await api.createRoom('Recovery', {displayName: 'hugo', kind: 'human'});
    const claude = await api.redeemInvite(room.invite.code, {displayName: 'claude', kind: 'agent'});
    const codex = await api.redeemInvite((await api.mintInvite(room.roomId, room.controllerCredential, 'member', true)).code, {displayName: 'codex', kind: 'agent'});
    const sessionId = newId('session');
    const local = new LocalStore(join(directory, 'device'));
    local.upsertRoom({roomId: room.roomId, name: 'Recovery', serverUrl: relay.url, createdAt: Date.now(), expiresAt: null, controls: true, sessions: []});
    local.addSession(room.roomId, {sessionId, participantId: room.participantId, displayName: 'hugo', kind: 'human', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: directory});
    local.addSession(room.roomId, {sessionId: newId('session'), participantId: claude.participantId, displayName: 'claude', kind: 'agent', runtime: 'claude', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: join(directory, 'claude-workspace')});
    local.addSession(room.roomId, {sessionId: newId('session'), participantId: codex.participantId, displayName: 'codex', kind: 'agent', runtime: 'codex', role: 'member', joinedAt: Date.now(), lastReadSeq: 0, cwd: join(directory, 'codex-workspace')});
    local.putCredential(room.roomId, sessionId, room.participantCredential);
    local.putCredential(room.roomId, 'controller', room.controllerCredential);
    const cli = async (...args: string[]) => JSON.parse((await execute(process.execPath, [process.env['PAIRLOBBY_TEST_CLI'] ?? resolve('packages/cli/dist/main.js'), ...args, '--room', room.roomId, '--session', sessionId, '--json'], {env: {...process.env, PAIRLOBBY_DATA_DIR: local.directory, PAIRLOBBY_NO_UPDATE_CHECK: '1'}, timeout: 10_000})).stdout);
    const ask = (to: string, text: string) => api.send(room.roomId, room.participantCredential, {type: 'message', recipientId: to, payload: {text, priority: 'normal'}, idempotencyKey: newId('event')});
    const fail = (credential: string, id: string, reason: string) => api.send(room.roomId, credential, {type: 'message.delivery_failed', payload: {eventId: id, reason, stage: 'execution'}, idempotencyKey: newId('event')});
    const original = (id: string) => api.request(room.roomId, room.participantCredential, id);
    try {
        const survey = await ask(claude.participantId, 'Build the survey foundation');
        await expect(cli('request', 'retry', survey.event.eventId)).rejects.toThrow(/has not failed/);
        await fail(claude.participantCredential, survey.event.eventId, 'Claude produced no runtime activity for 10 minutes; work was stopped, not retried.');
        const failedRequests = (await cli('requests')).requests as ListedRequest[];
        expect(failedRequests.find((request) => request.eventId === survey.event.eventId)!.allowedActions).toEqual(['retry', 'reassign', 'dismiss', 'cancel']);

        const retry = await cli('request', 'retry', survey.event.eventId);
        expect(retry).toMatchObject({recoversRequestId: survey.event.eventId, attempt: 2, to: claude.participantId, toName: 'claude', reassigned: false});
        // Running the command again makes no second attempt.
        expect((await cli('request', 'retry', survey.event.eventId)).requestId).toBe(retry.requestId);
        const attempt = await api.request(room.roomId, claude.participantCredential, retry.requestId);
        expect(attempt.text).toContain(`Recovery of request ${survey.event.eventId}, attempt 2.`);
        expect(attempt.text).toContain('no runtime activity for 10 minutes');
        expect(attempt.text).toContain('Inspect the workspace');
        expect(attempt.text).toContain('Do not repeat side effects');
        expect(attempt.text).toContain(`Workspace: ${join(directory, 'claude-workspace')}`);
        expect(attempt.text.endsWith('Original request:\nBuild the survey foundation')).toBe(true);

        await api.acknowledgeMessage(room.roomId, claude.participantCredential, retry.requestId);
        const answer = await api.reply(room.roomId, claude.participantCredential, retry.requestId, 'Survey foundation finished; tests pass');
        const resolved = await original(survey.event.eventId);
        expect(resolved).toMatchObject({responseEventId: answer.event.eventId, failureAt: expect.any(Number)});
        expect(messageActionLabel(resolved)).toBe('Done · recovered');
        await expect(cli('request', 'retry', survey.event.eventId)).rejects.toThrow(/already resolved/);

        const evidence = await ask(claude.participantId, 'Store the evidence');
        await fail(claude.participantCredential, evidence.event.eventId, 'Claude exceeded the 1 hour absolute request limit; work was stopped, not retried.');
        await expect(cli('request', 'reassign', evidence.event.eventId)).rejects.toThrow(/request reassign <request-id> --to <name>/);
        await expect(cli('request', 'reassign', evidence.event.eventId, '--to', 'nobody')).rejects.toThrow(/Nobody here is called nobody/);
        const reassigned = await cli('request', 'reassign', evidence.event.eventId, '--to', '@codex');
        expect(reassigned).toMatchObject({attempt: 2, to: codex.participantId, toName: 'codex', reassigned: true});
        expect((await api.request(room.roomId, codex.participantCredential, reassigned.requestId)).text).toContain('The previous attempt by claude was stopped: Claude exceeded the 1 hour absolute request limit');
        await api.acknowledgeMessage(room.roomId, codex.participantCredential, reassigned.requestId);
        const stored = await api.reply(room.roomId, codex.participantCredential, reassigned.requestId, 'Evidence stored');
        expect(await original(evidence.event.eventId)).toMatchObject({to: claude.participantId, responseEventId: stored.event.eventId});

        const obsolete = await ask(claude.participantId, 'Obsolete failed request');
        await fail(claude.participantCredential, obsolete.event.eventId, 'Partial work was inspected manually');
        const dismissed = await cli('request', 'dismiss', obsolete.event.eventId, '--reason', 'No more work is needed');
        expect(dismissed).toEqual({requestId: obsolete.event.eventId, outcome: 'dismissed', reason: 'No more work is needed', deduplicated: false});
        expect((await cli('request', 'dismiss', obsolete.event.eventId, '--reason', 'No more work is needed')).deduplicated).toBe(true);
        expect(await original(obsolete.event.eventId)).toMatchObject({resolution: 'dismissed', requiresReply: false, failureReason: 'Partial work was inspected manually'});
        const dismissedRequests = (await cli('requests')).requests as ListedRequest[];
        expect(dismissedRequests.find((request) => request.eventId === obsolete.event.eventId)).toBeUndefined();

        const superseded = await ask(claude.participantId, 'Superseded request');
        const cancelled = await cli('request', 'cancel', superseded.event.eventId, '--reason', 'Replaced by a more precise task');
        expect(cancelled).toMatchObject({requestId: superseded.event.eventId, outcome: 'cancelled', reason: 'Replaced by a more precise task'});
        expect(await original(superseded.event.eventId)).toMatchObject({resolution: 'cancelled', requiresReply: false});
        const retryCancelled = await cli('request', 'retry', superseded.event.eventId);
        expect(retryCancelled).toMatchObject({attempt: 2, recoversRequestId: superseded.event.eventId, to: claude.participantId});

        const agentRequest = await api.send(room.roomId, codex.participantCredential, {type: 'message', recipientId: claude.participantId, payload: {text: 'Agent-owned failed work', priority: 'normal'}, idempotencyKey: newId('event')});
        await fail(claude.participantCredential, agentRequest.event.eventId, 'Agent request failed');
        expect(await cli('request', 'dismiss', agentRequest.event.eventId)).toMatchObject({outcome: 'dismissed'});
    } finally {
        api.closeLive();
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 60_000);

test('test_recovery_text_keeps_a_very_long_request_under_the_message_limit', () => {
    const failed = {roomId: 'rm_X', eventId: 'ev_01234567890123456789012345', seq: 1, from: 'pt_a', to: 'pt_b', text: 'x'.repeat(40_000), at: 1, requiresReply: true, receivedAt: null, responseEventId: null, respondedAt: null, progressAt: null, failureAt: 2, failureReason: '', attempt: 3};
    const text = recoveryText(failed, 'claude', false);
    expect(text.length).toBeLessThan(32 * 1024);
    expect(text).toContain('attempt 4. The previous attempt was stopped: no reason was recorded');
    expect(text.endsWith('[original request shortened]')).toBe(true);
});

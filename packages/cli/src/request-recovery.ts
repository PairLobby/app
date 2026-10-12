//! A new attempt at a request that failed, for the same participant or another.
//!
//! The relay keeps the failed attempt as it is and resolves it when the new one is
//! answered. What this adds is the wording: an attempt that was stopped part-way may
//! have left work behind, so the new one is told to look before it does anything.

import type {PairLobbyClient} from '@pairlobby/client';
import type {MessageRequest} from '@pairlobby/protocol';

import {UsageError} from './context.js';

export type RecoveryTarget = {client: PairLobbyClient; roomId: string; credential: string; workspaceForParticipant?: (participantId: string) => string | undefined};
export type Recovery = {requestId: string; recoversRequestId: string; attempt: number; to: string; toName: string; reassigned: boolean};
export type RequestDisposition = {requestId: string; outcome: 'dismissed' | 'cancelled'; reason: string; deduplicated: boolean};

/** Room for the instructions around a long original request, under the 32 KiB message limit. */
const MAX_ORIGINAL = 24_000;

export function recoveryText(failed: MessageRequest, previousName: string, reassigned: boolean, workspace?: string): string {
    const original = failed.text.length > MAX_ORIGINAL ? `${failed.text.slice(0, MAX_ORIGINAL)}\n[original request shortened]` : failed.text;
    const location = workspace ? `Workspace: ${workspace.slice(0, 1024)}` : 'Workspace: use the receiver\'s configured working directory; the sender cannot verify its path on this device.';
    return [
        `Recovery of request ${failed.eventId}, attempt ${(failed.attempt ?? 1) + 1}. The previous attempt${reassigned ? ` by ${previousName}` : ''} was stopped: ${failed.failureReason?.trim() || 'no reason was recorded'}`,
        `Previous attempt: ${(failed.attempt ?? 1)} · stage: ${failed.failureStage ?? 'unknown'} · failed: ${failed.failureAt ? new Date(failed.failureAt).toISOString() : 'time unknown'}`,
        location,
        '',
        'It may have left partial work behind. Before changing anything:',
        '1. Inspect the workspace for what the earlier attempt already did.',
        '2. Do not repeat side effects that are already complete.',
        '3. Finish only what remains, then run validation.',
        'Answer this message when the work is done; your answer also resolves the original request.',
        '',
        'Original request:',
        original
    ].join('\n');
}

/** Safe instruction for another provider invocation of the same logical request. */
export function providerRetryText(request: MessageRequest): string {
    return [
        `Provider recovery attempt ${(request.attempt ?? 1)} for PairLobby request ${request.eventId}.`,
        'A previous provider invocation stopped at its usage limit and may have changed files or external state before stopping.',
        'Inspect the workspace and existing state before acting. Do not repeat completed writes, messages, commits, purchases, deployments, or other side effects.',
        'Finish only what remains, validate the result, and then answer the original request.',
        '',
        'Original request:',
        request.text
    ].join('\n');
}

/** Sends the new attempt. `toRef` names another participant to give the work to; without it the same one is asked again. */
export async function recoverRequest({client, roomId, credential, workspaceForParticipant}: RecoveryTarget, requestId: string, toRef?: string): Promise<Recovery> {
    if (!/^ev_[0-9A-Z]{26}$/.test(requestId)) {
        throw new UsageError('Give the failed request\'s delivery ID (ev_…), as shown by pairlobby requests.');
    }
    const snapshot = await client.snapshot(roomId, credential);
    if (!snapshot.requestRecoverySupported) {
        throw new UsageError('This relay cannot retry requests yet. Update it, or send the request again by hand after inspecting the workspace.');
    }
    const failed = await client.request(roomId, credential, requestId);
    // Checked here as well as by the relay: repeating the command returns the earlier attempt, which would hide these.
    if (failed.responseEventId || (!failed.requiresReply && failed.resolution !== 'cancelled')) {
        throw new UsageError(`Request ${requestId} is already resolved.`);
    }
    if (!failed.failureAt && !failed.providerWait) {
        throw new UsageError(`Request ${requestId} has not failed or entered provider wait. Wait for it, or cancel it first.`);
    }
    if (failed.providerWait && (!toRef || toRef === failed.to)) {
        throw new UsageError(`Request ${requestId} is waiting for its provider. Use Retry provider now, or reassign it to another participant.`);
    }
    const active = snapshot.participants.filter((participant) => !participant.left && !participant.revoked);
    const name = (participantId: string) => snapshot.participants.find((participant) => participant.participantId === participantId)?.displayName ?? participantId;
    let to = failed.to;
    if (toRef) {
        const wanted = toRef.replace(/^@/, '').toLowerCase();
        const matches = active.filter((participant) => participant.participantId === toRef || participant.displayName.toLowerCase() === wanted);
        if (matches.length !== 1) {
            throw new UsageError(matches.length ? `Several participants are called ${toRef}; use a participant ID.` : `Nobody here is called ${toRef}.`);
        }
        to = matches[0]!.participantId;
    } else if (!active.some((participant) => participant.participantId === to)) {
        throw new UsageError(`${name(to)} is no longer in the room. Give the request to someone else with: pairlobby request reassign ${requestId} --to <name>`);
    }
    const reassigned = to !== failed.to;
    // One key per failed attempt: repeating the command returns the attempt already made.
    const sent = await client.send(roomId, credential, {type: 'message', recipientId: to, payload: {text: recoveryText(failed, name(failed.to), reassigned, workspaceForParticipant?.(to)), priority: 'normal', recovers: requestId}, idempotencyKey: `recover-${requestId}`});
    return {requestId: sent.event.eventId, recoversRequestId: requestId, attempt: (failed.attempt ?? 1) + 1, to, toName: name(to), reassigned};
}

export async function closeRequest({client, roomId, credential}: RecoveryTarget, requestId: string, action: 'dismiss' | 'cancel', reason?: string): Promise<RequestDisposition> {
    if (!/^ev_[0-9A-Z]{26}$/.test(requestId)) {
        throw new UsageError('Give the request\'s delivery ID (ev_…), as shown by pairlobby requests.');
    }
    if (!(await client.snapshot(roomId, credential)).requestResolutionSupported) {
        throw new UsageError('This relay cannot dismiss or cancel requests yet. Update it before using this action.');
    }
    const result = await client.resolveRequest(roomId, credential, requestId, action, reason);
    return {requestId, outcome: action === 'dismiss' ? 'dismissed' : 'cancelled', reason: result.request.resolutionReason ?? '', deduplicated: result.deduplicated};
}

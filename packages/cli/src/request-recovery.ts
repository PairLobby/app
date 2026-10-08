//! A new attempt at a request that failed, for the same participant or another.
//!
//! The relay keeps the failed attempt as it is and resolves it when the new one is
//! answered. What this adds is the wording: an attempt that was stopped part-way may
//! have left work behind, so the new one is told to look before it does anything.

import type {PairLobbyClient} from '@pairlobby/client';
import type {MessageRequest} from '@pairlobby/protocol';

import {UsageError} from './context.js';

export type RecoveryTarget = {client: PairLobbyClient; roomId: string; credential: string};
export type Recovery = {requestId: string; recoversRequestId: string; attempt: number; to: string; toName: string; reassigned: boolean};

/** Room for the instructions around a long original request, under the 32 KiB message limit. */
const MAX_ORIGINAL = 24_000;

export function recoveryText(failed: MessageRequest, previousName: string, reassigned: boolean): string {
    const original = failed.text.length > MAX_ORIGINAL ? `${failed.text.slice(0, MAX_ORIGINAL)}\n[original request shortened]` : failed.text;
    return [
        `Recovery of request ${failed.eventId}, attempt ${(failed.attempt ?? 1) + 1}. The previous attempt${reassigned ? ` by ${previousName}` : ''} was stopped: ${failed.failureReason?.trim() || 'no reason was recorded'}`,
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

/** Sends the new attempt. `toRef` names another participant to give the work to; without it the same one is asked again. */
export async function recoverRequest({client, roomId, credential}: RecoveryTarget, requestId: string, toRef?: string): Promise<Recovery> {
    if (!/^ev_[0-9A-Z]{26}$/.test(requestId)) {
        throw new UsageError('Give the failed request\'s delivery ID (ev_…), as shown by pairlobby requests.');
    }
    const snapshot = await client.snapshot(roomId, credential);
    if (!snapshot.requestRecoverySupported) {
        throw new UsageError('This relay cannot retry requests yet. Update it, or send the request again by hand after inspecting the workspace.');
    }
    const failed = await client.request(roomId, credential, requestId);
    // Checked here as well as by the relay: repeating the command returns the earlier attempt, which would hide these.
    if (failed.responseEventId || !failed.requiresReply) {
        throw new UsageError(`Request ${requestId} is already resolved.`);
    }
    if (!failed.failureAt) {
        throw new UsageError(`Request ${requestId} has not failed. Wait for it, or cancel it first.`);
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
    const sent = await client.send(roomId, credential, {type: 'message', recipientId: to, payload: {text: recoveryText(failed, name(failed.to), reassigned), priority: 'normal', recovers: requestId}, idempotencyKey: `recover-${requestId}`});
    return {requestId: sent.event.eventId, recoversRequestId: requestId, attempt: (failed.attempt ?? 1) + 1, to, toName: name(to), reassigned};
}

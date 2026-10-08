import {setTimeout as sleep} from 'node:timers/promises';
import {PairLobbyClient} from '@pairlobby/client';
import {ProtocolError} from '@pairlobby/protocol';
import type {MessageRequest} from '@pairlobby/protocol';

export type ReplyOutcome = {
    requestId: string;
    state: 'pending' | 'answered' | 'passed' | 'no_action' | 'declined' | 'skipped' | 'cancelled' | 'dismissed' | 'failed' | 'unavailable';
    senderId: string;
    responseEventId: string | null;
    text: string | null;
    reason: string | null;
};

export type ReplyWaitOptions = {
    serverUrl: string;
    roomId: string;
    credential: string;
    participantId: string;
    requestId: string;
    seconds: number;
    signal?: AbortSignal;
};

/** Only the durable reply to this outgoing delivery can complete a wait. */
export function replyOutcome(request: MessageRequest, participantId: string): ReplyOutcome {
    if (request.from !== participantId || request.to === participantId) {
        throw new Error('Wait for a request sent by your own participant to another member. For a group request, use its recipient delivery ID.');
    }
    let state: ReplyOutcome['state'] = 'pending';
    if (request.responseEventId) {
        state = 'answered';
    } else if (request.resolution) {
        state = request.resolution;
    } else if (request.action === 'no_action' || request.action === 'declined') {
        state = request.action;
    } else if (request.failureAt) {
        state = 'failed';
    } else if (['passed', 'skipped', 'cancelled', 'failed'].includes(request.turnStatus ?? '')) {
        state = request.turnStatus as ReplyOutcome['state'];
    } else if (!request.requiresReply) {
        throw new Error('This message does not require a reply. Wait for an addressed request, not a reply or room chatter.');
    }
    return {requestId: request.eventId, state, senderId: request.to, responseEventId: request.responseEventId, text: state === 'answered' ? request.responseText ?? null : null, reason: state === 'failed' ? request.failureReason ?? 'The recipient reported a failure.' : state === 'dismissed' || state === 'cancelled' ? request.resolutionReason ?? null : state === 'no_action' || state === 'declined' ? request.actionReason ?? null : null};
}

export function retryableReplyError(error: unknown): boolean {
    return error instanceof ProtocolError && error.code === 'server_unavailable';
}

/** A bounded, read-only check. Deadline expiry is pending, never delivery failure. */
export async function waitForReply(options: ReplyWaitOptions): Promise<ReplyOutcome> {
    if (!Number.isFinite(options.seconds) || options.seconds < 0 || options.seconds > 1800) {
        throw new Error('--wait must be between 0 and 1800 seconds');
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(options.seconds * 1000)));
    // A zero-second check still performs one request; other checks obey their wall-clock budget.
    const signal = options.seconds === 0 ? options.signal : options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const client = new PairLobbyClient(options.serverUrl, undefined, signal);
    const deadline = Date.now() + options.seconds * 1000;
    let latest: ReplyOutcome = {requestId: options.requestId, state: 'pending', senderId: '', responseEventId: null, text: null, reason: null};
    let unavailable = false;
    let checked = false;
    try {
        for (;;) {
            options.signal?.throwIfAborted();
            if (checked && Date.now() >= deadline) {
                return {...latest, state: unavailable ? 'unavailable' : 'pending', reason: unavailable ? 'Relay unavailable; the request was not marked failed.' : null};
            }
            try {
                const request = await client.request(options.roomId, options.credential, options.requestId);
                latest = replyOutcome(request, options.participantId);
                checked = true;
                unavailable = false;
                if (latest.state !== 'pending') {
                    return latest;
                }
                const snapshot = await client.snapshot(options.roomId, options.credential);
                if (snapshot.lifecycle !== 'open') {
                    return {...latest, state: 'unavailable', reason: `Room is ${snapshot.lifecycle}; reply waiting has stopped.`};
                }
            } catch (error) {
                options.signal?.throwIfAborted();
                if (timeout.aborted && options.seconds !== 0) {
                    return {...latest, state: 'unavailable', reason: 'Relay status could not be confirmed before the wait deadline.'};
                }
                if (!retryableReplyError(error)) {
                    throw error;
                }
                unavailable = true;
            }
            if (Date.now() >= deadline) {
                return {...latest, state: unavailable ? 'unavailable' : 'pending', reason: unavailable ? 'Relay unavailable; the request was not marked failed.' : null};
            }
            await sleep(Math.min(1000, deadline - Date.now()), undefined, options.signal ? {signal: options.signal} : {});
        }
    } finally {
        client.closeLive();
    }
}

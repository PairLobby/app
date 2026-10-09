//! Interactive request inspection and recovery controls for terminal chat.

import type {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {messageActionLabel, requestState} from '@pairlobby/protocol';
import type {MessageRequest, RoomSnapshot} from '@pairlobby/protocol';
import {receiverAttempts, receiverStatus} from './receiver.js';
import {closeRequest, recoverRequest} from './request-recovery.js';
import type {RoomPanelPage, RoomPanelRow} from './room-panel.js';
import {formatDuration} from './when.js';

export type RequestPanelContext = {
    client: PairLobbyClient;
    roomId: string;
    credential: string;
    participantId: string;
    store: LocalStore;
    controllerCredential?: string;
};

type RequestAccess = {
    authority?: string;
    snapshot: RoomSnapshot;
};

function participantName(snapshot: RoomSnapshot, participantId: string): string {
    return snapshot.participants.find((participant) => participant.participantId === participantId)?.displayName ?? participantId;
}

function access(context: RequestPanelContext, request: MessageRequest, snapshot: RoomSnapshot): RequestAccess {
    const self = snapshot.participants.find((participant) => participant.participantId === context.participantId);
    const authority = request.from === context.participantId || self?.role === 'controller'
        ? context.credential
        : context.controllerCredential;
    return {snapshot, ...(authority ? {authority} : {})};
}

function localSession(context: RequestPanelContext, participantId: string) {
    return context.store.room(context.roomId)?.sessions.find((session) => session.participantId === participantId);
}

function workspace(context: RequestPanelContext, participantId: string): string | undefined {
    return localSession(context, participantId)?.cwd;
}

function iso(value?: number | null): string {
    return value ? new Date(value).toISOString() : 'Not recorded';
}

function excerpt(text: string, limit = 120): string {
    const flat = text.replaceAll(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export async function requestsPage(context: RequestPanelContext): Promise<RoomPanelPage> {
    const [page, snapshot] = await Promise.all([
        context.client.requests(context.roomId, context.credential),
        context.client.snapshot(context.roomId, context.credential)
    ]);
    const rows: RoomPanelRow[] = page.requests.map((request) => ({
        id: request.eventId,
        label: `${participantName(snapshot, request.from)} → ${participantName(snapshot, request.to)}`,
        value: `${messageActionLabel(request)} · attempt ${request.attempt ?? 1} · ${excerpt(request.text, 70)}`,
        section: request.failureAt ? 'Attention' : requestState(request) === 'stalled' ? 'Attention' : 'Requests',
        hint: request.eventId,
        action: {kind: 'menu', load: () => requestPage(context, request.eventId)}
    }));
    if (!rows.length) {
        rows.push({id: 'empty', label: 'Requests', value: 'No unresolved requests', section: 'Ready'});
    }
    return {
        id: 'requests',
        title: `Requests — ${snapshot.name}`,
        rows,
        note: page.hasMore ? 'More than 100 requests exist; use the shell command with --after to page.' : 'Enter inspects a request · R refreshes · actions never claim success.',
        reload: () => requestsPage(context)
    };
}

export async function requestPage(context: RequestPanelContext, requestId: string): Promise<RoomPanelPage> {
    const [request, snapshot] = await Promise.all([
        context.client.request(context.roomId, context.credential, requestId),
        context.client.snapshot(context.roomId, context.credential)
    ]);
    const {authority} = access(context, request, snapshot);
    const session = localSession(context, request.to);
    const attempts = session ? receiverAttempts(context.store, session.sessionId, request.eventId) : [];
    const activeStatus = session ? receiverStatus(context.store, session.sessionId) : null;
    const rows: RoomPanelRow[] = [
        {id: 'request-id', label: 'Request ID', value: request.eventId, section: 'Request'},
        {id: 'state', label: 'State', value: messageActionLabel(request), section: 'Request'},
        {id: 'from', label: 'From', value: `${participantName(snapshot, request.from)} · ${request.from}`, section: 'Request'},
        {id: 'to', label: 'To', value: `${participantName(snapshot, request.to)} · ${request.to}`, section: 'Request'},
        {id: 'attempt', label: 'Attempt', value: String(request.attempt ?? 1), section: 'Execution'},
        {id: 'created', label: 'Created', value: iso(request.at), section: 'Timing'},
        {id: 'received', label: 'Received', value: iso(request.receivedAt), section: 'Timing'},
        {id: 'read', label: 'Read', value: iso(request.readAt), section: 'Timing'},
        {id: 'text', label: 'Request', value: request.text, section: 'Content', hint: 'Enter copies the full request text.'}
    ];
    if (workspace(context, request.to)) {
        rows.push({id: 'workspace', label: 'Workspace', value: workspace(context, request.to)!, section: 'Execution'});
    }
    if (activeStatus?.eventId === request.eventId) {
        rows.push({id: 'runtime-attempt', label: 'Runtime attempt', value: `${activeStatus.attempt ?? '?'} · ${activeStatus.attemptId ?? 'not recorded'}`, section: 'Execution'});
        rows.push({id: 'idle-remaining', label: 'Inactivity remaining', value: activeStatus.idleRemainingMs === null || activeStatus.idleRemainingMs === undefined ? 'Unavailable' : formatDuration(activeStatus.idleRemainingMs), section: 'Timing'});
        rows.push({id: 'absolute-remaining', label: 'Absolute remaining', value: activeStatus.absoluteRemainingMs === null || activeStatus.absoluteRemainingMs === undefined ? 'Unavailable' : formatDuration(activeStatus.absoluteRemainingMs), section: 'Timing'});
    }
    if (request.failureAt) {
        rows.push({id: 'failure', label: 'Failure', value: request.failureReason ?? 'No reason recorded', section: 'Failure'});
        rows.push({id: 'failure-stage', label: 'Stage', value: request.failureStage ?? 'unknown', section: 'Failure'});
        rows.push({id: 'failure-at', label: 'Failed', value: iso(request.failureAt), section: 'Failure'});
    }
    if (request.resolution) {
        rows.push({id: 'resolution', label: 'Disposition', value: `${request.resolution}${request.resolutionReason ? ` · ${request.resolutionReason}` : ''}`, section: 'Resolution'});
        rows.push({id: 'resolution-at', label: 'Resolved', value: iso(request.resolutionAt), section: 'Resolution'});
    }
    if (request.responseEventId) {
        rows.push({id: 'response', label: 'Response event', value: request.responseEventId, section: 'Resolution'});
    }
    if (request.recoveredByEventId) {
        rows.push({id: 'recovered-by', label: 'Recovery attempt', value: request.recoveredByEventId, section: 'Resolution', action: {kind: 'menu', load: () => requestPage(context, request.recoveredByEventId!)}});
    }
    if (request.recoversEventId) {
        rows.push({id: 'recovers', label: 'Previous attempt', value: request.recoversEventId, section: 'Resolution', action: {kind: 'menu', load: () => requestPage(context, request.recoversEventId!)}});
    }
    if (attempts.length) {
        rows.push({id: 'attempt-history', label: 'Local attempt history', value: `${attempts.length} recorded`, section: 'Inspect', action: {kind: 'menu', load: () => attemptsPage(context, request.eventId)}});
    }
    const actionable = authority && !request.responseEventId && !request.recoveredByEventId && !request.resolution;
    if (actionable && request.failureAt && snapshot.requestRecoverySupported) {
        rows.push({id: 'retry', label: 'Retry safely', value: participantName(snapshot, request.to), section: 'Actions', action: {kind: 'command', confirm: 'Start a fresh managed attempt? It will inspect the existing workspace before changing anything.', run: async () => {
            await recoverRequest({client: context.client, roomId: context.roomId, credential: authority, workspaceForParticipant: (id) => workspace(context, id)}, request.eventId);
        }}});
        const targets = snapshot.participants.filter((participant) => !participant.left && !participant.revoked && participant.role !== 'guest');
        rows.push({id: 'reassign', label: 'Reassign safely', value: participantName(snapshot, request.to), section: 'Actions', action: {kind: 'edit', initial: request.to, choices: targets.map((participant) => ({label: `${participant.displayName} — ${participant.kind}`, value: participant.participantId})), hint: 'Choose the participant who should inspect and finish the remaining work.', confirm: (value) => `Give this failed request to ${participantName(snapshot, value)} as a fresh attempt?`, save: async (value) => {
            await recoverRequest({client: context.client, roomId: context.roomId, credential: authority, workspaceForParticipant: (id) => workspace(context, id)}, request.eventId, value);
        }}});
    }
    if (actionable && request.failureAt && snapshot.requestResolutionSupported) {
        rows.push({id: 'dismiss', label: 'Dismiss failure', value: 'No success claimed', section: 'Actions', action: dispositionEdit(context, authority, request.eventId, 'dismiss')});
    }
    if (actionable && request.requiresReply && snapshot.requestResolutionSupported) {
        rows.push({id: 'cancel', label: 'Cancel request', value: 'Fence any late answer', section: 'Actions', action: dispositionEdit(context, authority, request.eventId, 'cancel')});
    }
    return {
        id: `request-${request.eventId}`,
        title: `Request — ${request.eventId}`,
        rows,
        note: authority ? 'Recovery actions require confirmation and never erase earlier failure evidence.' : 'Read-only request details; only the sender or a room admin may recover it.',
        reload: () => requestPage(context, request.eventId)
    };
}

function dispositionEdit(context: RequestPanelContext, authority: string, requestId: string, action: 'dismiss' | 'cancel') {
    const label = action === 'dismiss' ? 'dismiss this failed request' : 'cancel and fence this request';
    return {
        kind: 'edit' as const,
        initial: '',
        hint: 'Optional reason. The action is recorded in room history and never claims success.',
        confirm: (value: string) => `${label[0]!.toUpperCase()}${label.slice(1)}${value.trim() ? `: ${value.trim()}` : ''}?`,
        save: async (value: string) => {
            await closeRequest({client: context.client, roomId: context.roomId, credential: authority}, requestId, action, value.trim() || undefined);
        }
    };
}

async function attemptsPage(context: RequestPanelContext, requestId: string): Promise<RoomPanelPage> {
    const request = await context.client.request(context.roomId, context.credential, requestId);
    const session = localSession(context, request.to);
    const attempts = session ? receiverAttempts(context.store, session.sessionId, requestId) : [];
    const rows: RoomPanelRow[] = attempts.map((attempt) => ({
        id: attempt.attemptId,
        label: `Attempt ${attempt.ordinal}`,
        value: `${attempt.terminal?.kind ?? 'running'} · ${attempt.resolvedModel ?? attempt.model ?? attempt.runtime} · ${iso(attempt.startedAt)}`,
        section: 'Attempts',
        action: {kind: 'menu', load: () => attemptPage(context, requestId, attempt.attemptId)}
    }));
    if (!rows.length) {
        rows.push({id: 'empty', label: 'Attempt history', value: 'No local records', section: 'Attempts'});
    }
    return {id: `attempts-${requestId}`, title: `Attempt history — ${requestId}`, rows, note: 'Append-only local evidence from the device that owns this receiver.', reload: () => attemptsPage(context, requestId)};
}

async function attemptPage(context: RequestPanelContext, requestId: string, attemptId: string): Promise<RoomPanelPage> {
    const request = await context.client.request(context.roomId, context.credential, requestId);
    const session = localSession(context, request.to);
    const attempt = session ? receiverAttempts(context.store, session.sessionId, requestId).find((candidate) => candidate.attemptId === attemptId) : undefined;
    if (!attempt) {
        return attemptsPage(context, requestId);
    }
    const rows: RoomPanelRow[] = [
        {id: 'attempt-id', label: 'Attempt ID', value: attempt.attemptId, section: 'Attempt'},
        {id: 'ordinal', label: 'Ordinal', value: String(attempt.ordinal), section: 'Attempt'},
        {id: 'runtime', label: 'Runtime', value: attempt.runtime, section: 'Runtime'},
        {id: 'model', label: 'Model', value: attempt.resolvedModel ?? attempt.model ?? 'Not reported', section: 'Runtime'},
        {id: 'thread', label: 'Provider thread', value: attempt.runtimeStarted?.providerThreadId ?? attempt.providerThreadId ?? 'Not reported', section: 'Runtime'},
        {id: 'process', label: 'Process', value: String(attempt.runtimeStarted?.processId ?? attempt.receiverProcessId), section: 'Runtime'},
        {id: 'started', label: 'Started', value: iso(attempt.startedAt), section: 'Timing'},
        {id: 'last-activity', label: 'Last activity', value: iso(attempt.lastActivityAt), section: 'Timing'},
        {id: 'answer-saved', label: 'Answer saved', value: attempt.answerSaved ? 'Yes' : 'No', section: 'Outcome'},
        {id: 'terminal', label: 'Terminal outcome', value: attempt.terminal?.kind ?? 'Still running / incomplete', section: 'Outcome'}
    ];
    if (attempt.terminal?.failureReason) {
        rows.push({id: 'reason', label: 'Reason', value: attempt.terminal.failureReason, section: 'Outcome'});
    }
    if (attempt.terminal?.responseEventId) {
        rows.push({id: 'response', label: 'Response event', value: attempt.terminal.responseEventId, section: 'Outcome'});
    }
    return {id: `attempt-${attemptId}`, title: `Attempt — ${attemptId}`, rows, note: 'Immutable local execution evidence.', reload: () => attemptPage(context, requestId, attemptId)};
}

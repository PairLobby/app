import {expect, test} from 'vitest';
import type {RoomEvent, MessageRequest} from '@pairlobby/protocol';
import {activityDetails, activityFocusAt, agentActivities, activitySummary} from '../src/agent-activity.js';
import type {AgentActivityContext} from '../src/agent-activity.js';

const participant = {participantId: 'agent', displayName: 'Claude', kind: 'agent' as const, role: 'member' as const, capabilities: null, joinedAt: 1, revoked: false, left: false, paused: false, controlRevision: 0, acknowledgedOutcome: null};
const context: AgentActivityContext = {participants: [participant], requests: [], queue: {mode: 'sequential', entries: []}, complete: true, available: true};
const message: RoomEvent = {protocolVersion: 1, roomId: 'room', eventId: 'latest', seq: 10, senderId: 'human', recipientId: null, replyTo: null, idempotencyKey: null, at: 100, type: 'message', payload: {text: 'For another agent', priority: 'normal'}};
const request: MessageRequest = {roomId: 'room', eventId: 'request', seq: 9, from: 'human', to: 'agent', text: 'Please work', at: 99, requiresReply: true, receivedAt: 100, responseEventId: null, respondedAt: null, progressAt: null};
const caughtUp = {latestMessage: message, acknowledged: new Set(['agent']), now: 1000};

test('idle requires an explicit terminal decision; transport receipts and failures cannot imply idle', () => {
    expect(agentActivities(context, {...caughtUp, acknowledged: new Set()})[0]!.state).toBe('unread');
    expect(agentActivities(context, caughtUp)[0]!.state).toBe('clear');
    expect(activitySummary(agentActivities(context, {...caughtUp, settled: new Set(['agent'])}))).toContain('All agents idle (1)');
    expect(agentActivities({...context, requests: [request]}, caughtUp)[0]!.state).toBe('waiting');
    expect(agentActivities({...context, requests: [{...request, failureAt: 999, turnStatus: 'failed'}]}, caughtUp)[0]!.state).toBe('failed');
    expect(agentActivities({...context, requests: [{...request, turnStatus: 'passed'}]}, {...caughtUp, settled: new Set(['agent'])})[0]!.state).toBe('idle');
    expect(agentActivities(context, {...caughtUp, latestMessage: {...message, eventId: 'new'}, acknowledged: new Set()})[0]!.state).toBe('unread');
});

test('working, claimed and expired turns never appear idle after acknowledgements', () => {
    const entry = {requestId: 'r', conversationId: 'root', participantId: 'agent', name: 'Claude', state: 'answering' as const, expiresAt: 2000};
    expect(agentActivities({...context, queue: {mode: 'parallel', entries: [entry]}}, caughtUp)[0]!.state).toBe('preparing');
    expect(agentActivities({...context, queue: {mode: 'parallel', entries: [{...entry, workingAt: 500}]}}, caughtUp)[0]!.state).toBe('working');
    expect(agentActivities({...context, queue: {mode: 'parallel', entries: [{...entry, workingAt: 500, expiresAt: 999}]}}, caughtUp)[0]!.state).toBe('stalled');
    expect(agentActivities({...context, queue: {mode: 'parallel', entries: [{...entry, state: 'provider_wait', expiresAt: null}]}}, caughtUp)[0]!.state).toBe('provider_wait');
    expect(activitySummary(agentActivities({...context, queue: {mode: 'parallel', entries: [{...entry, state: 'provider_wait', expiresAt: null}]}}, caughtUp))).toContain('provider limited');
});

test('partial history, unavailable data and paused members cannot produce all-idle', () => {
    expect(agentActivities({...context, complete: false}, caughtUp)[0]!.state).toBe('unknown');
    expect(agentActivities({...context, available: false}, caughtUp)[0]!.state).toBe('unknown');
    expect(agentActivities({...context, participants: [{...participant, paused: true}]}, caughtUp)[0]!.state).toBe('paused');
    expect(agentActivities({...context, participants: [{...participant, left: true}]}, caughtUp)).toEqual([]);
    expect(activitySummary([])).toBe('No agents in the room');
    expect(agentActivities(context, {...caughtUp, latestMessage: {...message, senderId: 'agent'}, acknowledged: new Set()})[0]!.state).toBe('clear');
});

test('an agent whose receiver on this device is not running counts as offline, even with a request waiting', () => {
    const offline = {...context, requests: [request], offline: new Set(['agent'])};
    expect(agentActivities(offline, caughtUp)[0]!.state).toBe('offline');
    expect(activitySummary(agentActivities(offline, caughtUp))).toBe('Agents: 1 offline');
    expect(agentActivities({...context, requests: [request], offline: new Set(['someone else'])}, caughtUp)[0]!.state).toBe('waiting');
});

test('hovering each activity count lists only its agents and disambiguates duplicate display names', () => {
    const agents = [{participantId: 'participant-one111', name: 'API reviewer', state: 'preparing' as const}, {participantId: 'participant-two222', name: 'API reviewer', state: 'working' as const}, {participantId: 'participant-three', name: 'Billing reconciliation', state: 'waiting' as const}];
    const summary = `Turns: parallel | ${activitySummary(agents)}`;
    expect(activityFocusAt(agents, 'parallel', 2, (text) => text.length)).toBe('turns');
    expect(activityFocusAt(agents, 'parallel', summary.indexOf('preparing'), (text) => text.length)).toBe('preparing');
    expect(activityFocusAt(agents, 'parallel', summary.indexOf('working'), (text) => text.length)).toBe('working');
    expect(activityDetails(agents, 'preparing', null, new Map())).toEqual(['Agents · Preparing an answer', 'API reviewer (one111) — Preparing an answer']);
    expect(activityDetails(agents, 'working', null, new Map())).toEqual(['Agents · Working', 'API reviewer (two222) — Working']);
});

test('turn hover includes current names and distinguishes preparation, work, queued and expired turns', () => {
    const turn = {requestId: 'request', conversationId: 'root', participantId: 'agent', name: 'old name', state: 'answering' as const, expiresAt: 2000};
    const names = new Map([['agent', 'Relay sync']]);
    expect(activityDetails([], 'turns', {mode: 'sequential', entries: [turn]}, names, 1000)).toContain('Relay sync — Preparing an answer');
    expect(activityDetails([], 'turns', {mode: 'parallel', entries: [{...turn, workingAt: 100}]}, names, 1000)).toContain('Relay sync — Working');
    expect(activityDetails([], 'turns', {mode: 'parallel', entries: [turn]}, names, 3000)).toContain('Relay sync — Stalled request');
    expect(activityDetails([], 'turns', {mode: 'parallel', entries: [{...turn, state: 'waiting'}]}, names, 1000)).toContain('Relay sync — Waiting · pending request');
});

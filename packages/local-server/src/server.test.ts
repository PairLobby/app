//! End-to-end over real HTTP, including the defenses a loopback server still
//! needs: a page in the user's own browser can reach 127.0.0.1, so neither the
//! address nor the absence of a proxy is authentication.

import {request as httpRequest} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {PROTOCOL_VERSION_HEADER, newCredential, newId} from '@pairlobby/protocol';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';

import {startServer, type RunningServer} from './server.js';

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-http-'));
let server: RunningServer;

beforeAll(async () => {
    server = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
});

afterAll(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

function call(path: string, init: RequestInit & {credential?: string} = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    if (init.credential) headers.set('authorization', `Bearer ${init.credential}`);
    return fetch(`${server.url}${path}`, {...init, headers});
}

async function createRoom(baseUrl = server.url) {
    const controllerCredential = newCredential('controller');
    const participantCredential = newCredential('participant');
    const response = await fetch(`${baseUrl}/v1/rooms`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'http-room', displayName: 'claude', kind: 'agent', controllerCredential, participantCredential})});
    expect(response.status).toBe(201);
    const body = await response.json() as {room: {roomId: string}; participantId: string; invite: {code: string}};
    return {roomId: body.room.roomId, participantId: body.participantId, invite: body.invite, controllerCredential, participantCredential};
}

function rawGet(path: string, headers: Record<string, string>): Promise<{status: number}> {
    return new Promise((resolve, reject) => {
        const outgoing = httpRequest({host: '127.0.0.1', port: server.port, path, method: 'GET', headers}, (incoming) => {
            incoming.resume();
            incoming.on('end', () => resolve({status: incoming.statusCode ?? 0}));
        });
        outgoing.on('error', reject);
        outgoing.end();
    });
}

describe('local server over http', () => {
    test('test_a_room_round_trips_through_create_join_send_and_read', async () => {
        const room = await createRoom();
        const joinerCredential = newCredential('participant');
        const joined = await call('/v1/invites/redeem', {method: 'POST', body: JSON.stringify({code: room.invite.code, displayName: 'codex', kind: 'agent', attemptId: newId('attempt'), attemptSecret: newCredential('attempt'), participantCredential: joinerCredential})});
        expect(joined.status).toBe(200);
        const membership = await joined.json() as {participantId: string; roomId: string};
        expect(membership.roomId).toBe(room.roomId);

        const key = newId('event');
        const sent = await call(`/v1/rooms/${room.roomId}/events`, {method: 'POST', credential: room.participantCredential, body: JSON.stringify({type: 'message', payload: {text: 'over http'}, idempotencyKey: key, recipientId: membership.participantId})});
        expect(sent.status).toBe(201);

        const retried = await call(`/v1/rooms/${room.roomId}/events`, {method: 'POST', credential: room.participantCredential, body: JSON.stringify({type: 'message', payload: {text: 'over http'}, idempotencyKey: key, recipientId: membership.participantId})});
        expect(retried.status).toBe(200);
        expect((await retried.json() as {deduplicated: boolean}).deduplicated).toBe(true);

        const read = await call(`/v1/rooms/${room.roomId}/events?after=0`, {credential: joinerCredential});
        const page = await read.json() as {events: {type: string}[]};
        expect(page.events.filter((event) => event.type === 'message')).toHaveLength(1);
    });

    test('test_the_controller_can_pause_a_participant_over_http', async () => {
        const room = await createRoom();
        const response = await call(`/v1/rooms/${room.roomId}/control`, {method: 'POST', credential: room.controllerCredential, body: JSON.stringify({targetParticipantId: room.participantId, paused: true})});
        expect(response.status).toBe(200);
        const snapshot = await (await call(`/v1/rooms/${room.roomId}`, {credential: room.controllerCredential})).json() as {participants: {participantId: string; paused: boolean}[]};
        expect(snapshot.participants.find((participant) => participant.participantId === room.participantId)!.paused).toBe(true);
    });

    test('test_a_member_cannot_use_the_control_route', async () => {
        const room = await createRoom();
        const response = await call(`/v1/rooms/${room.roomId}/control`, {method: 'POST', credential: room.participantCredential, body: JSON.stringify({targetParticipantId: room.participantId, paused: true})});
        expect(response.status).toBe(401);
        expect((await response.json() as {error: {code: string}}).error.code).toBe('unauthorized');
    });

    test('test_a_web_page_origin_is_refused_even_on_loopback', async () => {
        const room = await createRoom();
        const response = await call(`/v1/rooms/${room.roomId}`, {credential: room.controllerCredential, headers: {origin: 'https://evil.example'}});
        expect(response.status).toBe(401);
    });

    // fetch silently drops a caller-set Host header, so DNS rebinding has to be
    // exercised over a raw request or the defense is never actually tested.
    test('test_an_unexpected_host_header_is_refused', async () => {
        const room = await createRoom();
        const rebound = await rawGet(`/v1/rooms/${room.roomId}`, {authorization: `Bearer ${room.controllerCredential}`, host: 'rebound.example'});
        expect(rebound.status).toBe(401);
        const expected = await rawGet(`/v1/rooms/${room.roomId}`, {authorization: `Bearer ${room.controllerCredential}`, host: `127.0.0.1:${server.port}`});
        expect(expected.status).toBe(200);
    });

    test('test_a_missing_credential_is_unauthorized', async () => {
        const room = await createRoom();
        expect((await call(`/v1/rooms/${room.roomId}`)).status).toBe(401);
    });

    test('test_an_unknown_protocol_version_is_refused_before_the_body_is_read', async () => {
        const room = await createRoom();
        const response = await call(`/v1/rooms/${room.roomId}`, {credential: room.controllerCredential, headers: {[PROTOCOL_VERSION_HEADER]: '99'}});
        expect(response.status).toBe(400);
        expect((await response.json() as {error: {code: string}}).error.code).toBe('protocol_version_unsupported');
    });

    test('test_a_malformed_body_is_a_schema_error_not_a_crash', async () => {
        const response = await call('/v1/rooms', {method: 'POST', body: JSON.stringify({name: ''})});
        expect(response.status).toBe(400);
        expect((await response.json() as {error: {code: string}}).error.code).toBe('invalid_request');
    });

    test('test_history_and_pause_state_survive_a_restart', async () => {
        const dataFile = join(directory, 'restart.sqlite');
        const first = await startServer({port: 0, dataFile});
        const room = await createRoom(first.url);
        const authed = (credential: string) => ({'content-type': 'application/json', authorization: `Bearer ${credential}`});
        await fetch(`${first.url}/v1/rooms/${room.roomId}/events`, {method: 'POST', headers: authed(room.participantCredential), body: JSON.stringify({type: 'message', payload: {text: 'before restart'}, idempotencyKey: newId('event')})});
        await fetch(`${first.url}/v1/rooms/${room.roomId}/control`, {method: 'POST', headers: authed(room.controllerCredential), body: JSON.stringify({targetParticipantId: room.participantId, paused: true})});
        await first.close();

        const second = await startServer({port: 0, dataFile});
        const snapshot = await (await fetch(`${second.url}/v1/rooms/${room.roomId}`, {headers: authed(room.controllerCredential)})).json() as {participants: {participantId: string; paused: boolean}[]};
        expect(snapshot.participants.find((participant) => participant.participantId === room.participantId)!.paused).toBe(true);
        const page = await (await fetch(`${second.url}/v1/rooms/${room.roomId}/events?after=0`, {headers: authed(room.participantCredential)})).json() as {events: {type: string}[]};
        expect(page.events.some((event) => event.type === 'message')).toBe(true);
        await second.close();
    });
});

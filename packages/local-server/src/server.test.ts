//! End-to-end over real HTTP, including the defenses a loopback server still
//! needs: a page in the user's own browser can reach 127.0.0.1, so neither the
//! address nor the absence of a proxy is authentication.

import {request as httpRequest} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {hostname, networkInterfaces, tmpdir} from 'node:os';
import {join} from 'node:path';

import {PROTOCOL_VERSION_HEADER, inviteProbe, newCredential, newId, normalizeInviteCode} from '@pairlobby/protocol';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';

import {peerAllowed, startServer, type RunningServer} from './server.js';
import {SqliteRoomStore} from './sqlite-store.js';

type AuthenticatedRequestOptions = RequestInit & {credential?: string};

type HttpStatusResult = {status: number};

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-http-'));
let server: RunningServer;

beforeAll(async () => {
    server = await startServer({port: 0, dataFile: join(directory, 'rooms.sqlite')});
});

afterAll(async () => {
    await server.close();
    rmSync(directory, {recursive: true, force: true});
});

function call(path: string, init: AuthenticatedRequestOptions = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    if (init.credential) {
        headers.set('authorization', `Bearer ${init.credential}`);
    }
    return fetch(`${server.url}${path}`, {...init, headers});
}

async function createRoom(baseUrl = server.url) {
    const controllerCredential = newCredential('controller');
    const participantCredential = newCredential('participant');
    const response = await fetch(`${baseUrl}/v1/rooms`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({name: 'http-room', displayName: 'claude', kind: 'agent', controllerCredential, participantCredential})
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {room: {roomId: string}; participantId: string; invite: {code: string}};
    return {roomId: body.room.roomId, participantId: body.participantId, invite: body.invite, controllerCredential, participantCredential};
}

function rawGet(path: string, headers: Record<string, string>, port = server.port): Promise<HttpStatusResult> {
    return new Promise((resolve, reject) => {
        const outgoing = httpRequest({host: '127.0.0.1', port, path, method: 'GET', headers}, (incoming) => {
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
        const joined = await call('/v1/invites/redeem', {
            method: 'POST',
            body: JSON.stringify({
                code: room.invite.code,
                displayName: 'codex',
                kind: 'agent',
                attemptId: newId('attempt'),
                attemptSecret: newCredential('attempt'),
                participantCredential: joinerCredential
            })
        });
        expect(joined.status).toBe(200);
        const membership = (await joined.json()) as {participantId: string; roomId: string};
        expect(membership.roomId).toBe(room.roomId);

        const key = newId('event');
        const sent = await call(`/v1/rooms/${room.roomId}/events`, {
            method: 'POST',
            credential: room.participantCredential,
            body: JSON.stringify({type: 'message', payload: {text: 'over http'}, idempotencyKey: key, recipientId: membership.participantId})
        });
        expect(sent.status).toBe(201);

        const retried = await call(`/v1/rooms/${room.roomId}/events`, {
            method: 'POST',
            credential: room.participantCredential,
            body: JSON.stringify({type: 'message', payload: {text: 'over http'}, idempotencyKey: key, recipientId: membership.participantId})
        });
        expect(retried.status).toBe(200);
        expect(((await retried.json()) as {deduplicated: boolean}).deduplicated).toBe(true);

        const read = await call(`/v1/rooms/${room.roomId}/events?after=0`, {credential: joinerCredential});
        const page = (await read.json()) as {events: {type: string}[]};
        expect(page.events.filter((event) => event.type === 'message')).toHaveLength(1);
    });

    test('test_the_controller_can_pause_a_participant_over_http', async () => {
        const room = await createRoom();
        const response = await call(`/v1/rooms/${room.roomId}/control`, {
            method: 'POST',
            credential: room.controllerCredential,
            body: JSON.stringify({targetParticipantId: room.participantId, paused: true})
        });
        expect(response.status).toBe(200);
        const snapshot = (await (await call(`/v1/rooms/${room.roomId}`, {credential: room.controllerCredential})).json()) as {
            participants: {participantId: string; paused: boolean}[];
        };
        expect(snapshot.participants.find((participant) => participant.participantId === room.participantId)!.paused).toBe(true);
    });

    test('test_a_member_cannot_use_the_control_route', async () => {
        const room = await createRoom();
        const response = await call(`/v1/rooms/${room.roomId}/control`, {
            method: 'POST',
            credential: room.participantCredential,
            body: JSON.stringify({targetParticipantId: room.participantId, paused: true})
        });
        expect(response.status).toBe(401);
        expect(((await response.json()) as {error: {code: string}}).error.code).toBe('unauthorized');
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
        expect(((await response.json()) as {error: {code: string}}).error.code).toBe('protocol_version_unsupported');
    });

    test('test_a_malformed_body_is_a_schema_error_not_a_crash', async () => {
        const response = await call('/v1/rooms', {method: 'POST', body: JSON.stringify({name: ''})});
        expect(response.status).toBe(400);
        expect(((await response.json()) as {error: {code: string}}).error.code).toBe('invalid_request');
    });

    test('test_history_and_pause_state_survive_a_restart', async () => {
        const dataFile = join(directory, 'restart.sqlite');
        const first = await startServer({port: 0, dataFile});
        const room = await createRoom(first.url);
        const authed = (credential: string) => ({'content-type': 'application/json', authorization: `Bearer ${credential}`});
        await fetch(`${first.url}/v1/rooms/${room.roomId}/events`, {
            method: 'POST',
            headers: authed(room.participantCredential),
            body: JSON.stringify({type: 'message', payload: {text: 'before restart'}, idempotencyKey: newId('event')})
        });
        await fetch(`${first.url}/v1/rooms/${room.roomId}/control`, {
            method: 'POST',
            headers: authed(room.controllerCredential),
            body: JSON.stringify({targetParticipantId: room.participantId, paused: true})
        });
        await first.close();

        const second = await startServer({port: 0, dataFile});
        const snapshot = (await (await fetch(`${second.url}/v1/rooms/${room.roomId}`, {headers: authed(room.controllerCredential)})).json()) as {
            participants: {participantId: string; paused: boolean}[];
        };
        expect(snapshot.participants.find((participant) => participant.participantId === room.participantId)!.paused).toBe(true);
        const page = (await (await fetch(`${second.url}/v1/rooms/${room.roomId}/events?after=0`, {headers: authed(room.participantCredential)})).json()) as {
            events: {type: string}[];
        };
        expect(page.events.some((event) => event.type === 'message')).toBe(true);
        await second.close();
    });
});

function networkAddresses(): string[] {
    return Object.values(networkInterfaces()).flatMap((addresses) => (addresses ?? []).filter((address) => address.family === 'IPv4' && !address.internal).map((address) => address.address));
}

describe('local server shared with other devices', () => {
    test('test_a_loopback_server_has_nothing_to_share', async () => {
        const response = await call('/v1/server');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({shareUrls: [], discoverable: false});
        expect(server.shareUrls).toEqual([]);
    });

    test('test_a_server_on_every_interface_answers_to_its_own_addresses_only', async () => {
        const lan = await startServer({host: '0.0.0.0', port: 0, dataFile: join(directory, 'lan.sqlite')});
        try {
            expect(lan.url).toBe(`http://127.0.0.1:${lan.port}`);
            const room = await createRoom(lan.url);
            const authorization = `Bearer ${room.controllerCredential}`;
            for (const name of [hostname(), ...networkAddresses()]) {
                expect((await rawGet(`/v1/rooms/${room.roomId}`, {authorization, host: `${name}:${lan.port}`}, lan.port)).status).toBe(200);
            }
            expect((await rawGet(`/v1/rooms/${room.roomId}`, {authorization, host: `rebound.example:${lan.port}`}, lan.port)).status).toBe(401);
            expect((await rawGet(`/v1/rooms/${room.roomId}`, {authorization, host: `${hostname()}:${lan.port + 1}`}, lan.port)).status).toBe(401);
        } finally {
            await lan.close();
        }
    });

    test('test_a_server_on_every_interface_shares_its_network_addresses', async () => {
        const lan = await startServer({host: '0.0.0.0', port: 0, dataFile: join(directory, 'lan-share.sqlite')});
        try {
            const expected = networkAddresses().map((address) => `http://${address}:${lan.port}`);
            expect(lan.shareUrls).toEqual(expected);
            // Not on the default port and not announced over mDNS, so a bare code cannot find it.
            expect(await (await fetch(`${lan.url}/v1/server`)).json()).toEqual({shareUrls: expected, discoverable: false});
        } finally {
            await lan.close();
        }
    });

    test('test_an_advertised_relay_is_discoverable_unless_it_has_a_public_url', async () => {
        const announced = await startServer({host: '0.0.0.0', port: 0, dataFile: join(directory, 'announced.sqlite'), advertise: true});
        const proxied = await startServer({host: '0.0.0.0', port: 0, dataFile: join(directory, 'announced-proxied.sqlite'), advertise: true, publicUrl: 'https://laptop.tailnet.example'});
        try {
            expect(announced.discoverable).toBe(true);
            expect(proxied.discoverable).toBe(false);
        } finally {
            await Promise.all([announced.close(), proxied.close()]);
        }
    });

    test('test_a_public_url_is_shared_and_accepted_as_host', async () => {
        const proxied = await startServer({port: 0, dataFile: join(directory, 'proxied.sqlite'), publicUrl: 'https://laptop.tailnet.example/'});
        try {
            expect(proxied.shareUrls).toEqual(['https://laptop.tailnet.example']);
            const room = await createRoom(`http://127.0.0.1:${proxied.port}`);
            expect((await rawGet(`/v1/rooms/${room.roomId}`, {authorization: `Bearer ${room.controllerCredential}`, host: 'laptop.tailnet.example'}, proxied.port)).status).toBe(200);
        } finally {
            await proxied.close();
        }
    });
});

describe('local server names, peers and invite probes', () => {
    test('test_extra_hostnames_are_accepted_on_a_shared_relay', async () => {
        const shared = await startServer({host: '0.0.0.0', port: 0, dataFile: join(directory, 'names.sqlite'), hostnames: ['h', 'h.example-tailnet.ts.net']});
        try {
            const room = await createRoom(`http://127.0.0.1:${shared.port}`);
            const authorization = `Bearer ${room.controllerCredential}`;
            for (const name of ['h', 'H.example-tailnet.ts.net']) {
                expect((await rawGet(`/v1/rooms/${room.roomId}`, {authorization, host: `${name}:${shared.port}`}, shared.port)).status).toBe(200);
            }
            expect((await rawGet(`/v1/rooms/${room.roomId}`, {authorization, host: `attacker.example:${shared.port}`}, shared.port)).status).toBe(401);
        } finally {
            await shared.close();
        }
    });

    test('test_a_loopback_relay_answers_to_no_names_but_loopback', async () => {
        const local = await startServer({port: 0, dataFile: join(directory, 'loopback-names.sqlite'), hostnames: ['h']});
        try {
            const room = await createRoom(local.url);
            expect((await rawGet(`/v1/rooms/${room.roomId}`, {authorization: `Bearer ${room.controllerCredential}`, host: `h:${local.port}`}, local.port)).status).toBe(401);
        } finally {
            await local.close();
        }
    });

    test('test_a_tailscale_only_relay_admits_loopback_and_tailscale_peers', () => {
        for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.111.208.123', '::ffff:100.127.255.254', 'fd7a:115c:a1e0::1']) {
            expect(peerAllowed('tailscale', address)).toBe(true);
        }
        for (const address of ['10.0.0.240', '192.168.1.20', '100.63.255.255', '100.128.0.1', 'fe80::1', '']) {
            expect(peerAllowed('tailscale', address)).toBe(false);
        }
        expect(peerAllowed('any', '10.0.0.240')).toBe(true);
    });

    test('test_the_invite_probe_finds_only_codes_this_relay_issued', async () => {
        const relay = await startServer({port: 0, dataFile: join(directory, 'probe.sqlite')});
        try {
            const room = await createRoom(relay.url);
            const probe = await inviteProbe(normalizeInviteCode(room.invite.code)!);
            const other = `${probe[0] === 'f' ? '0' : 'f'}${probe.slice(1)}`;
            expect(await (await fetch(`${relay.url}/v1/invites/probe?prefix=${probe}`)).json()).toEqual({known: true});
            expect(await (await fetch(`${relay.url}/v1/invites/probe?prefix=${other}`)).json()).toEqual({known: false});
            expect((await fetch(`${relay.url}/v1/invites/probe?prefix=${probe}0`)).status).toBe(400);
            expect((await fetch(`${relay.url}/v1/invites/probe?prefix=ZZZZ`)).status).toBe(400);
        } finally {
            await relay.close();
        }
    });
});

describe('local server auto-close timer', () => {
    test('test_the_relay_closes_an_idle_room_on_its_own_without_a_request', async () => {
        const dataFile = join(directory, 'auto-close.sqlite');
        const relay = await startServer({port: 0, dataFile});
        try {
            const room = await createRoom(relay.url);
            const response = await fetch(`${relay.url}/v1/rooms/${room.roomId}/auto-close`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${room.controllerCredential}`}, body: JSON.stringify({autoClose: {mode: 'inactivity', afterMs: 1000}})});
            expect(response.status).toBe(200);
            await new Promise((resolve) => setTimeout(resolve, 1600));
            // Read the file directly: going through the relay would close it on request instead.
            const raw = new SqliteRoomStore(dataFile);
            try {
                expect((await raw.loadRoom(room.roomId))?.room).toMatchObject({lifecycle: 'closed', closeReason: 'inactivity'});
            } finally {
                raw.close();
            }
        } finally {
            await relay.close();
        }
    });

    test('test_a_restarted_relay_closes_rooms_that_fell_due_while_it_was_down', async () => {
        const dataFile = join(directory, 'auto-close-restart.sqlite');
        const first = await startServer({port: 0, dataFile});
        const room = await createRoom(first.url);
        await fetch(`${first.url}/v1/rooms/${room.roomId}/auto-close`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${room.controllerCredential}`}, body: JSON.stringify({autoClose: {mode: 'inactivity', afterMs: 1000}})});
        await first.close();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const second = await startServer({port: 0, dataFile});
        await new Promise((resolve) => setTimeout(resolve, 300));
        await second.close();
        const raw = new SqliteRoomStore(dataFile);
        try {
            expect((await raw.loadRoom(room.roomId))?.room.lifecycle).toBe('closed');
        } finally {
            raw.close();
        }
    });
});

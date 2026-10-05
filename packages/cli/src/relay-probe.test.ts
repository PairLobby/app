import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {createServer as createTcpServer} from 'node:net';
import type {AddressInfo, Socket} from 'node:net';

import {afterEach, expect, test} from 'vitest';

import {askRelay, probeRelayForInvite, relayLocalRooms} from './relay-probe.js';

type SilentDevice = {url: string; sockets: Socket[]; closed: number};

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
});

/** A relay stand-in that answers each path with a fixed status and JSON body. */
async function relay(answers: Record<string, [number, unknown]>): Promise<string> {
    const server: Server = createServer((request, response) => {
        const [status, body] = answers[request.url ?? ''] ?? [404, {error: {code: 'invalid_request'}}];
        response.writeHead(status, {'content-type': 'application/json'});
        response.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    closers.push(() => new Promise((done) => server.close(() => done())));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A device that accepts the connection and then says nothing, like a firewall that drops packets. */
async function silentDevice(): Promise<SilentDevice> {
    const sockets: Socket[] = [];
    const device: SilentDevice = {url: '', sockets, closed: 0};
    const server = createTcpServer((socket) => {
        sockets.push(socket);
        socket.on('error', () => {});
        socket.on('close', () => { device.closed += 1; });
        // Reading is what lets this end notice the other side closing; it still never answers.
        socket.resume();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    closers.push(() => new Promise((done) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(() => done());
    }));
    device.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return device;
}

test('test_a_relay_that_answers_is_read_as_json', async () => {
    const url = await relay({'/v1/server': [200, {shareUrls: []}]});
    expect(await askRelay(`${url}/v1/server`)).toEqual({status: 200, body: {shareUrls: []}});
    expect((await askRelay(`${url}/nowhere`))?.status).toBe(404);
});

test('test_a_silent_device_is_given_up_on_in_time_and_its_socket_is_closed', async () => {
    const device = await silentDevice();
    const started = Date.now();
    expect(await askRelay(`${device.url}/v1/server`, 200)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    // The process can only exit promptly if nothing is left open towards the device.
    for (let waited = 0; waited < 1000 && device.closed < device.sockets.length; waited += 20) {
        await new Promise((done) => setTimeout(done, 20));
    }
    expect(device.sockets).toHaveLength(1);
    expect(device.closed).toBe(1);
});

test('test_an_aborted_question_ends_at_once', async () => {
    const device = await silentDevice();
    const controller = new AbortController();
    const pending = askRelay(`${device.url}/v1/server`, 10_000, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    expect(await askRelay(`${device.url}/v1/server`, 10_000, controller.signal)).toBeNull();
});

test('test_unreachable_malformed_and_non_json_answers_are_null', async () => {
    const url = await relay({'/v1/server': [200, 'not json']});
    expect(await askRelay(`${url}/v1/server`)).toBeNull();
    expect(await askRelay('http://127.0.0.1:1/v1/server', 500)).toBeNull();
    expect(await askRelay('not a url')).toBeNull();
});

test('test_invite_probe_answers_map_to_known_unknown_unsupported_unreachable', async () => {
    const url = await relay({'/v1/invites/probe?prefix=aaaa': [200, {known: true}], '/v1/invites/probe?prefix=bbbb': [200, {known: false}], '/v1/invites/probe?prefix=cccc': [401, {error: {code: 'unauthorized'}}]});
    expect(await probeRelayForInvite(url, 'aaaa')).toBe('known');
    expect(await probeRelayForInvite(url, 'bbbb')).toBe('unknown');
    expect(await probeRelayForInvite(url, 'cccc')).toBe('unreachable');
    expect(await probeRelayForInvite(url, 'dddd')).toBe('unsupported');
    expect(await probeRelayForInvite('http://127.0.0.1:1', 'aaaa')).toBe('unreachable');
});

test('test_local_rooms_are_listed_by_name_or_all_and_null_when_the_relay_cannot_say', async () => {
    const room = {roomId: 'rm_A', name: 'tower-test', createdAt: 1, participantCount: 2};
    const url = await relay({'/v1/rooms/local': [200, {rooms: [room]}], '/v1/rooms/local?name=tower-test': [200, {rooms: [room]}], '/v1/rooms/local?name=other': [200, {rooms: []}], '/v1/rooms/local?name=refused': [401, {error: {code: 'unauthorized'}}]});
    expect(await relayLocalRooms(url)).toEqual([room]);
    expect(await relayLocalRooms(url, 'tower-test')).toEqual([room]);
    expect(await relayLocalRooms(url, 'other')).toEqual([]);
    expect(await relayLocalRooms(url, 'refused')).toBeNull();
    expect(await relayLocalRooms('http://127.0.0.1:1')).toBeNull();
});

import {afterEach, expect, test, vi} from 'vitest';

import {PairLobbyClient} from '../src/client.js';

type Answer = {status: number; body: unknown};

/** A fetch that answers `/v1/server` with `description` and records every other path it is asked. */
function relay(description: Answer, asked: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        asked.push(`${url.pathname}${url.search}`);
        if (url.pathname.endsWith('/v1/server')) {
            return new Response(JSON.stringify(description.body), {status: description.status});
        }
        return new Response(JSON.stringify({events: [], earliestSeq: 0, latestSeq: 3, hasMore: false}), {status: 200});
    }) as typeof fetch;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

test('test_the_transport_comes_from_the_description_then_from_the_address', async () => {
    const cases: [string, Answer, string][] = [
        ['http://relay.example.com', {status: 200, body: {transport: {live: 'long-poll', maxWaitMs: 25_000}}}, 'long-poll'],
        ['http://relay.example.com', {status: 200, body: {transport: {live: 'something-newer'}}}, 'poll'],
        ['http://relay.example.com', {status: 404, body: {error: {code: 'invalid_request', message: 'unknown path'}}}, 'poll'],
        ['https://pairlobby.example.com/relay/abc', {status: 404, body: {error: {code: 'invalid_request', message: 'unknown path'}}}, 'websocket'],
        ['https://pairlobby.example.com/relay/abc', {status: 200, body: {features: ['files']}}, 'websocket']
    ];
    for (const [url, answer, expected] of cases) {
        vi.stubGlobal('fetch', relay(answer, []));
        expect(await new PairLobbyClient(url).liveTransport()).toBe(expected);
    }
});

test('test_a_long_poll_wait_holds_one_read_and_asks_for_the_description_once', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', relay({status: 200, body: {transport: {live: 'long-poll', maxWaitMs: 25_000}}}, asked));
    const client = new PairLobbyClient('http://relay.example.com');
    await client.waitForChange('rm_a', 'credential', 3, 300_000);
    await client.waitForChange('rm_a', 'credential', 3, 5_000);
    expect(asked).toEqual(['/v1/server', '/v1/rooms/rm_a/events?after=3&limit=1&wait=25000', '/v1/rooms/rm_a/events?after=3&limit=1&wait=5000']);
});

test('test_a_long_poll_that_cannot_reach_the_relay_sleeps_like_polling', async () => {
    const asked: string[] = [];
    const described = relay({status: 200, body: {transport: {live: 'long-poll'}}}, asked);
    vi.stubGlobal('fetch', (async (input: string | URL | Request) => {
        if (String(input).includes('/events')) {
            throw new TypeError('fetch failed');
        }
        return described(input);
    }) as typeof fetch);
    const started = Date.now();
    await new PairLobbyClient('http://relay.example.com').waitForChange('rm_a', 'credential', 3, 300_000, 200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
});

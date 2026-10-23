import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {afterAll, describe, expect, test} from 'vitest';

import {checkRelay} from '../src/check.js';
import {startServer} from '../src/server.js';

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-check-'));

afterAll(() => {
    rmSync(directory, {recursive: true, force: true});
});

describe('checking a deployed relay', () => {
    test('test_a_relay_with_a_token_passes_every_step_and_keeps_no_test_room', async () => {
        const dataFile = join(directory, 'token.sqlite');
        const relay = await startServer({port: 0, dataFile, createToken: 'team-secret'});
        const steps = await checkRelay(relay.url, {createToken: 'team-secret'});
        await relay.close();
        expect(steps.map(({name, ok}) => [name, ok])).toEqual([['health', true], ['invite address', false], ['create token', true], ['join', true], ['send', true], ['read', true], ['delete', true]]);
        // Listening only on loopback, the relay shows no address; a deployed one is given PAIRLOBBY_PUBLIC_URL.
        expect(steps[1]?.detail).toContain(`PAIRLOBBY_PUBLIC_URL=${relay.url}`);
        const db = new DatabaseSync(dataFile, {readOnly: true});
        try {
            // A deleted room keeps only its tombstone, with every event, member and invite gone.
            expect(db.prepare("SELECT json_extract(body, '$.lifecycle') AS lifecycle FROM rooms").all()).toEqual([{lifecycle: 'deleted'}]);
            expect(db.prepare('SELECT count(*) AS events FROM events').get()).toEqual({events: 0});
        } finally {
            db.close();
        }
    });

    test('test_without_the_token_the_check_stops_after_showing_creation_is_protected', async () => {
        const relay = await startServer({port: 0, dataFile: join(directory, 'no-token.sqlite'), createToken: 'team-secret'});
        try {
            const missing = await checkRelay(relay.url);
            expect(missing.slice(2)).toEqual([{name: 'create token', ok: true, detail: 'required, and the relay refused a room without it'}, {name: 'create room', ok: false, detail: 'set PAIRLOBBY_CREATE_TOKEN to the relay\'s token to check the rest'}]);
            const wrong = await checkRelay(relay.url, {createToken: 'other'});
            expect(wrong.at(-1)).toMatchObject({name: 'create token', ok: false});
        } finally {
            await relay.close();
        }
    });

    test('test_an_open_relay_is_flagged_and_its_public_url_is_confirmed', async () => {
        const relay = await startServer({port: 0, dataFile: join(directory, 'open.sqlite')});
        const probe = new URL(relay.url);
        await relay.close();
        const listening = await startServer({port: Number(probe.port), dataFile: join(directory, 'open.sqlite'), publicUrl: relay.url});
        try {
            const steps = await checkRelay(relay.url);
            expect(steps.every((step) => step.ok)).toBe(true);
            expect(steps[1]?.detail).toBe(`invites show ${relay.url}`);
            expect(steps[2]?.detail).toContain('anyone who reaches this address');
        } finally {
            await listening.close();
        }
    });

    test('test_something_that_is_not_a_relay_fails_at_health', async () => {
        const notRelay = (async () => new Response('<html>sign in</html>', {status: 302})) as unknown as typeof fetch;
        expect(await checkRelay('https://intranet.example.com', {fetch: notRelay})).toEqual([{name: 'health', ok: false, detail: 'GET /health answered 302; is this the relay, or something in front of it?'}]);
        const unreachable = (async () => {
            throw new Error('fetch failed');
        }) as unknown as typeof fetch;
        expect(await checkRelay('https://intranet.example.com', {fetch: unreachable})).toEqual([{name: 'health', ok: false, detail: 'fetch failed'}]);
    });
});

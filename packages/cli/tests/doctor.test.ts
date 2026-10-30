import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, beforeAll, beforeEach, expect, test, vi} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

import {doctorCommand, doctorReport, requireRelayFeature} from '../src/doctor.js';

let directory: string;
let relay: RunningServer;
let local: LocalStore;

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-doctor-'));
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite'), createToken: 'team-secret', version: '9.9.9'});
    local = new LocalStore(join(directory, 'device'));
});

afterAll(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

beforeEach(() => {
    vi.stubEnv('PAIRLOBBY_ONLINE_ORIGIN', '');
    vi.stubEnv('PAIRLOBBY_ACCOUNT_TOKEN', '');
});

test('test_doctor_reports_what_the_relay_describes', async () => {
    const report = await doctorReport(local, relay.url);
    expect(report).toMatchObject({reachable: true, relay: relay.url, description: {version: '9.9.9', protocol: 1, transport: {live: 'long-poll'}}, endpoint: {origin: 'https://pairlobby.com', tokenSaved: false}});
    expect(report.description?.features).toContain('create-token');

    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
    });
    expect(await doctorCommand(local, relay.url, false)).toBe(0);
    vi.restoreAllMocks();
    const text = lines.join('');
    expect(text).toContain('Relay version   9.9.9 (protocol 1)');
    expect(text).toContain('Transport       long-poll (holds reads up to 25 s)');
    expect(text).toContain('Receipts        an event per message and reader, and a watermark per participant');
    expect(text).toMatch(/New rooms\s+participants 16, message 32 KB/);
});

test('test_doctor_says_when_the_relay_cannot_be_reached', async () => {
    const report = await doctorReport(local, 'http://127.0.0.1:9');
    expect(report.reachable).toBe(false);
    expect(report.error).toContain('could not reach');
});

test('test_a_feature_the_relay_does_not_list_is_refused_and_one_it_lists_passes', async () => {
    const client = new PairLobbyClient(relay.url);
    await requireRelayFeature(client, 'files', 'files');
    // The loopback relay lists local-join; a relay description without it is refused by name.
    vi.spyOn(client, 'describe').mockResolvedValue({features: ['message-stages']});
    await expect(requireRelayFeature(client, 'local-join', 'joining by name')).rejects.toThrow(`This relay (${relay.url}) does not support joining by name.`);
    vi.spyOn(client, 'describe').mockResolvedValue(null);
    await requireRelayFeature(client, 'local-join', 'joining by name');
});

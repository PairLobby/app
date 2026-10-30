import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, beforeAll, expect, test} from 'vitest';
import {startServer} from '@pairlobby/local-server';
import type {RunningServer} from '@pairlobby/local-server';

import {CHECKS, parityMatrix, runConformance} from '../src/index.js';

let directory: string;
let open: RunningServer;
let guarded: RunningServer;

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-conformance-'));
    open = await startServer({port: 0, dataFile: join(directory, 'open.sqlite')});
    // Watermark-only receipts here, so the checks cover both receipt modes a relay offers.
    guarded = await startServer({port: 0, dataFile: join(directory, 'guarded.sqlite'), createToken: 'conformance-token', receiptMode: 'watermark'});
});

afterAll(async () => {
    await Promise.all([open.close(), guarded.close()]);
    rmSync(directory, {recursive: true, force: true});
});

test('test_the_node_relay_passes_every_check', async () => {
    const plain = await runConformance({relay: open.url});
    const withToken = await runConformance({relay: guarded.url, createToken: 'conformance-token'});
    const matrix = parityMatrix({node: plain, 'node with create token': withToken});
    if (process.env['PAIRLOBBY_PARITY_FILE']) {
        writeFileSync(process.env['PAIRLOBBY_PARITY_FILE'], `${matrix}\n`);
    }
    expect(plain.results.filter((result) => result.status === 'fail'), matrix).toEqual([]);
    expect(withToken.results.filter((result) => result.status === 'fail'), matrix).toEqual([]);
    expect(plain.results.find((result) => result.id === 'create-token')?.status).toBe('skip');
    expect(withToken.results.map((result) => result.status)).toEqual(CHECKS.map(() => 'pass'));
});

test('test_a_relay_that_needs_a_token_fails_without_it_and_says_why', async () => {
    const report = await runConformance({relay: guarded.url, only: ['create-join-send-read']});
    expect(report.passed).toBe(false);
    expect(report.results[0]?.detail).toContain('create token');
});

import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import {afterEach, beforeEach, expect, test} from 'vitest';
import {LocalStore} from '@pairlobby/client';

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-serve-'));
});

afterEach(() => {
    rmSync(directory, {recursive: true, force: true});
});

/** Starts `pairlobby serve`, returns what it printed once it is listening, then stops it. */
function serveOutput(args: string[]): Promise<string> {
    return new Promise((done, fail) => {
        // A missing Tailscale binary keeps the test independent of this machine's tailnet.
        const child = spawn(process.execPath, [resolve('packages/cli/dist/main.js'), 'serve', '--port', '0', '--data-dir', join(directory, 'relay'), ...args], {env: {...process.env, PAIRLOBBY_DATA_DIR: join(directory, 'client'), PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_TAILSCALE: join(directory, 'no-tailscale')}});
        let output = '';
        const collect = (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes('Press Ctrl+C')) {
                child.kill('SIGTERM');
            }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('error', fail);
        child.once('exit', () => done(output));
        setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
    });
}

test('test_serve_stays_on_loopback_by_default', async () => {
    const output = await serveOutput([]);
    expect(output).toMatch(/PairLobby server on http:\/\/127\.0\.0\.1:\d+/);
    expect(output).not.toMatch(/Shared with/);
});

test('test_serve_follows_the_network_sharing_setting', async () => {
    new LocalStore(join(directory, 'client')).setSettings({relayNetwork: 'tailscale'});
    const output = await serveOutput([]);
    expect(output).toMatch(/Shared with: this device and your Tailscale devices/);
    expect(output).not.toMatch(/unencrypted/);
});

test('test_serve_flags_override_the_setting', async () => {
    new LocalStore(join(directory, 'client')).setSettings({relayNetwork: 'tailscale'});
    expect(await serveOutput(['--host', '127.0.0.1'])).not.toMatch(/Shared with/);
    expect(await serveOutput(['--lan', '--tailscale'])).toMatch(/either --lan or --tailscale/);
});

//! Runs the built `pairlobby-relay` as a container would: settings only from the environment.

import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {afterAll, describe, expect, test} from 'vitest';

type StartLine = {event: string; url: string; createToken: boolean; backup: string | null; restore: string | null};

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'relay-main.js');
const directory = mkdtempSync(join(tmpdir(), 'pairlobby-relay-main-'));

afterAll(() => {
    rmSync(directory, {recursive: true, force: true});
});

function environment(extra: Record<string, string>): NodeJS.ProcessEnv {
    const {PAIRLOBBY_CREATE_TOKEN: _token, PAIRLOBBY_BACKUP: _backup, ...rest} = process.env;
    return {...rest, NODE_NO_WARNINGS: '1', ...extra};
}

describe('pairlobby-relay', () => {
    test('test_it_starts_from_the_environment_passes_its_own_check_and_backs_up_on_stop', async () => {
        const env = environment({PAIRLOBBY_DATA_DIR: join(directory, 'data'), PAIRLOBBY_PORT: '0', PAIRLOBBY_CREATE_TOKEN: 'team-secret', PAIRLOBBY_BACKUP: join(directory, 'copies')});
        const relay = spawn(process.execPath, [BIN], {env, stdio: ['ignore', 'pipe', 'inherit']});
        const lines: string[] = [];
        const start = await new Promise<StartLine>((resolve, reject) => {
            relay.once('exit', (code) => reject(new Error(`exited ${code}`)));
            relay.stdout.on('data', (chunk: Buffer) => {
                lines.push(...chunk.toString().split('\n').filter(Boolean));
                const found = lines.map((line) => JSON.parse(line) as StartLine).find((line) => line.event === 'start');
                if (found) {
                    resolve(found);
                }
            });
        });
        expect(start).toMatchObject({createToken: true, backup: join(directory, 'copies'), restore: 'no-backups'});

        const check = spawnSync(process.execPath, [BIN, 'check', start.url, '--json'], {env, encoding: 'utf8'});
        const steps = JSON.parse(check.stdout) as {name: string; ok: boolean}[];
        expect(steps.filter((step) => !step.ok).map((step) => step.name)).toEqual(['invite address']);
        expect(check.status).toBe(1);

        const exited = new Promise<number | null>((resolve) => relay.once('exit', resolve));
        relay.kill('SIGTERM');
        expect(await exited).toBe(0);
        const events = lines.map((line) => JSON.parse(line) as {event: string}).map((line) => line.event);
        expect(events.slice(-3)).toEqual(['stopping', 'backup', 'stop']);
    });

    test('test_bad_or_missing_settings_exit_2_with_a_message_naming_them', () => {
        const missing = spawnSync(process.execPath, [BIN], {env: environment({}), encoding: 'utf8'});
        expect(missing.status).toBe(2);
        expect(JSON.parse(missing.stdout)).toMatchObject({level: 'error', event: 'bad-settings', message: expect.stringContaining('PAIRLOBBY_DATA_DIR')});
        const bad = spawnSync(process.execPath, [BIN], {env: environment({PAIRLOBBY_DATA_DIR: directory, PAIRLOBBY_PORT: 'eighty'}), encoding: 'utf8'});
        expect(bad.status).toBe(2);
        expect(bad.stdout).toContain('--port (PAIRLOBBY_PORT) must be a whole number');
        expect(spawnSync(process.execPath, [BIN, 'check', 'not-a-url'], {env: environment({}), encoding: 'utf8'}).status).toBe(2);
    });
});

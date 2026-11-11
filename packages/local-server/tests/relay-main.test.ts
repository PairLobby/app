//! Runs the built `pairlobby-relay` as a container would: settings only from the environment.

import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
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
    const rest = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PAIRLOBBY_')));
    return {...rest, NODE_NO_WARNINGS: '1', PAIRLOBBY_PORT: '0', ...extra};
}

describe('pairlobby-relay', () => {
    test('test_it_starts_from_the_environment_passes_its_own_check_and_backs_up_on_stop', async () => {
        const env = environment({PAIRLOBBY_DATA_DIR: join(directory, 'data'), PAIRLOBBY_PORT: '0', PAIRLOBBY_CREATE_TOKEN: 'team-secret', PAIRLOBBY_BACKUP: join(directory, 'copies')});
        const relay = spawn(process.execPath, [BIN], {env, stdio: ['ignore', 'pipe', 'inherit']});
        try {
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

            const check = spawnSync(process.execPath, [BIN, 'check', start.url, '--json'], {env, encoding: 'utf8', timeout: 15_000});
            const steps = JSON.parse(check.stdout) as {name: string; ok: boolean}[];
            expect(steps.filter((step) => !step.ok).map((step) => step.name)).toEqual(['invite address']);
            expect(check.status).toBe(1);

            const exited = new Promise<number | null>((resolve) => relay.once('exit', resolve));
            relay.kill('SIGTERM');
            expect(await exited).toBe(0);
            const events = lines.map((line) => JSON.parse(line) as {event: string}).map((line) => line.event);
            expect(events.slice(-3)).toEqual(['stopping', 'backup', 'stop']);
        } finally {
            if (relay.exitCode === null && !relay.killed) {
                const stopped = new Promise<void>((resolve) => relay.once('exit', () => resolve()));
                relay.kill('SIGTERM');
                await stopped;
            }
        }
    });

    test('test_bad_or_missing_settings_exit_2_with_a_message_naming_them', () => {
        const missing = spawnSync(process.execPath, [BIN], {env: environment({}), encoding: 'utf8', timeout: 15_000});
        expect(missing.status).toBe(2);
        expect(JSON.parse(missing.stdout)).toMatchObject({level: 'error', event: 'bad-settings', message: expect.stringContaining('PAIRLOBBY_DATA_DIR')});
        const bad = spawnSync(process.execPath, [BIN], {env: environment({PAIRLOBBY_DATA_DIR: directory, PAIRLOBBY_PORT: 'eighty'}), encoding: 'utf8', timeout: 15_000});
        expect(bad.status).toBe(2);
        expect(bad.stdout).toContain('--port (PAIRLOBBY_PORT) must be a whole number');
        expect(spawnSync(process.execPath, [BIN, 'check', 'not-a-url'], {env: environment({}), encoding: 'utf8', timeout: 15_000}).status).toBe(2);
        writeFileSync(join(directory, 'broken-members.jsonl'), 'plm_not_a_line\n');
        const broken = spawnSync(process.execPath, [BIN], {env: environment({PAIRLOBBY_DATA_DIR: join(directory, 'broken'), PAIRLOBBY_PORT: '0', PAIRLOBBY_LOGIN_MODE: 'token', PAIRLOBBY_MEMBERS_FILE: join(directory, 'broken-members.jsonl')}), encoding: 'utf8', timeout: 15_000});
        expect(broken.status).toBe(2);
        expect(JSON.parse(broken.stdout)).toMatchObject({event: 'bad-settings', message: 'line 1 of the members file is not JSON'});
    });

    test('test_member_token_issues_a_token_once_and_sighup_rereads_the_members_file', async () => {
        const issue = (handle: string) => JSON.parse(spawnSync(process.execPath, [BIN, 'member-token', handle, '--json'], {env: environment({}), encoding: 'utf8', timeout: 15_000}).stdout) as {handle: string; token: string; line: object};
        const damien = issue('@Damien');
        const hugo = issue('hugo');
        expect(damien.handle).toBe('damien');
        expect(damien.token).toMatch(/^plm_/);
        expect(spawnSync(process.execPath, [BIN, 'member-token', 'all'], {env: environment({}), encoding: 'utf8', timeout: 15_000}).status).toBe(2);
        const members = join(directory, 'members.jsonl');
        writeFileSync(members, `${JSON.stringify(damien.line)}\n${JSON.stringify(hugo.line)}\n`);
        const env = environment({PAIRLOBBY_DATA_DIR: join(directory, 'members-data'), PAIRLOBBY_PORT: '0', PAIRLOBBY_LOGIN_MODE: 'token', PAIRLOBBY_MEMBERS_FILE: members});
        const relay = spawn(process.execPath, [BIN], {env, stdio: ['ignore', 'pipe', 'inherit']});
        const lines: string[] = [];
        const waitFor = (event: string) => new Promise<{event: string; url: string}>((resolve, reject) => {
            const look = () => {
                const found = lines.map((line) => JSON.parse(line) as {event: string; url: string}).find((line) => line.event === event);
                if (found) {
                    relay.stdout.off('data', read);
                    resolve(found);
                }
            };
            const read = (chunk: Buffer) => {
                lines.push(...chunk.toString().split('\n').filter(Boolean));
                look();
            };
            relay.once('exit', (code) => reject(new Error(`exited ${code}`)));
            relay.stdout.on('data', read);
            look();
        });
        try {
            const {url} = await waitFor('start');
            const account = (token: string) => fetch(`${url}/api/online/account`, {headers: {'x-pairlobby-account-token': token}});
            expect(await (await account(damien.token)).json()).toMatchObject({userId: 'member:damien', handle: 'damien'});
            writeFileSync(members, `${JSON.stringify(hugo.line)}\n`);
            relay.kill('SIGHUP');
            await waitFor('members-reloaded');
            expect((await account(damien.token)).status).toBe(401);
            expect((await account(hugo.token)).status).toBe(200);
            expect(lines.join('\n')).not.toContain('plm_');
        } finally {
            const exited = new Promise((resolve) => relay.once('exit', resolve));
            relay.kill('SIGTERM');
            await exited;
        }
    });
});

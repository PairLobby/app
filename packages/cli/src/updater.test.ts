import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {LocalStore} from '@pairlobby/client';
import {checkForInteractiveUpdate, checkForUpdate, compareVersions, currentVersion, fetchLatestRelease, installRelease, managedInstall, parseUpdateChoice, readUpdateState, scheduleBackgroundCheck, shouldOfferUpdate, updateNotice, writeUpdateState} from './updater.js';
import type {LatestRelease} from './updater.js';

const API = 'http://127.0.0.1:9/repos/PairLobby/app';
let directory: string;

beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'pairlobby-updater-')));
    vi.stubEnv('PAIRLOBBY_UPDATE_API', API);
    vi.stubEnv('PAIRLOBBY_INSTALL_DIR', join(directory, 'install'));
    vi.stubEnv('PAIRLOBBY_BIN_DIR', join(directory, 'bin'));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, {recursive: true, force: true});
});

function githubRelease(version: string, extra: Record<string, unknown> = {}): Response {
    const base = `https://github.com/PairLobby/app/releases/download/v${version}`;
    return Response.json({tag_name: `v${version}`, html_url: `https://github.com/PairLobby/app/releases/tag/v${version}`, assets: [{name: `pairlobby-cli-${version}.tgz`, browser_download_url: `${base}/pairlobby-cli-${version}.tgz`}, {name: `pairlobby-cli-${version}.tgz.sha256`, browser_download_url: `${base}/pairlobby-cli-${version}.tgz.sha256`}], ...extra});
}

function latest(version: string): LatestRelease {
    return {version, tag: `v${version}`, pageUrl: 'https://github.com/PairLobby/app/releases', archiveUrl: `https://example.test/pairlobby-cli-${version}.tgz`, checksumUrl: `https://example.test/pairlobby-cli-${version}.tgz.sha256`};
}

/** A release tarball shaped like scripts/build-distribution.mjs output. */
function packRelease(version: string): Buffer {
    const stage = join(directory, `stage-${version}`);
    mkdirSync(join(stage, 'package/dist'), {recursive: true});
    mkdirSync(join(stage, 'package/skills/pairlobby'), {recursive: true});
    writeFileSync(join(stage, 'package/package.json'), JSON.stringify({name: '@pairlobby/cli', version}));
    writeFileSync(join(stage, 'package/dist/main.mjs'), `console.log('PairLobby ${version} (test build)');\n`);
    writeFileSync(join(stage, 'package/skills/pairlobby/SKILL.md'), `skill ${version}\n`);
    execFileSync('tar', ['-czf', join(stage, 'release.tgz'), '-C', stage, 'package']);
    return readFileSync(join(stage, 'release.tgz'));
}

function installCurrent(): string {
    const entry = join(directory, 'install/releases/current/dist/main.mjs');
    mkdirSync(join(directory, 'install/releases/current/dist'), {recursive: true});
    writeFileSync(entry, '');
    mkdirSync(join(directory, 'bin'), {recursive: true});
    writeFileSync(join(directory, 'bin/pairlobby'), `#!/bin/sh\n# PairLobby managed launcher\nexec node '${entry}' "$@"\n`);
    return entry;
}

test('test_versions_order_numerically_with_prereleases_first', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('0.3.0', '0.4.0')).toBe(-1);
});

test('test_update_choices_distinguish_later_from_skipping_a_version', () => {
    expect(parseUpdateChoice('1')).toBe('update');
    expect(parseUpdateChoice('yes')).toBe('update');
    expect(parseUpdateChoice('')).toBe('later');
    expect(parseUpdateChoice('not now')).toBe('later');
    expect(parseUpdateChoice('3')).toBe('skip');
    expect(parseUpdateChoice('skip')).toBe('skip');
    expect(parseUpdateChoice('eventually')).toBeNull();
});

test('test_latest_release_needs_a_version_tag_and_both_assets', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(githubRelease('9.0.0'));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchLatestRelease()).toMatchObject({version: '9.0.0', tag: 'v9.0.0', archiveUrl: expect.stringContaining('pairlobby-cli-9.0.0.tgz')});
    expect(fetcher.mock.calls[0]![0]).toBe(`${API}/releases/latest`);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({message: 'Not Found'}, {status: 404})));
    expect(await fetchLatestRelease()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(githubRelease('9.0.0', {assets: []})));
    expect(await fetchLatestRelease()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(githubRelease('9.0.0-beta.1', {prerelease: true})));
    expect(await fetchLatestRelease()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', {status: 403})));
    await expect(fetchLatestRelease()).rejects.toThrow('rate limiting');
});

test('test_checks_are_cached_for_a_day_unless_forced', async () => {
    const store = new LocalStore(join(directory, 'data'));
    const fetcher = vi.fn().mockImplementation(async () => githubRelease('9.0.0'));
    vi.stubGlobal('fetch', fetcher);
    expect((await checkForUpdate(store)).available).toBe(true);
    expect((await checkForUpdate(store)).latest?.version).toBe('9.0.0');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await checkForUpdate(store, true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    writeUpdateState(store, {latest: latest(currentVersion())});
    expect((await checkForUpdate(store)).available).toBe(false);
});

test('test_interactive_startup_checks_every_time_instead_of_using_the_daily_cache', async () => {
    const store = new LocalStore(join(directory, 'interactive'));
    const fetcher = vi.fn().mockImplementation(async () => githubRelease('9.0.0'));
    vi.stubGlobal('fetch', fetcher);
    expect((await checkForInteractiveUpdate(store))?.available).toBe(true);
    expect((await checkForInteractiveUpdate(store))?.available).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);

    store.setSettings({updateCheck: false});
    expect(await checkForInteractiveUpdate(store)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
});

test('test_only_installer_layouts_count_as_managed', () => {
    const entry = installCurrent();
    expect(managedInstall(entry)).toEqual({root: expect.stringContaining('install'), launcher: join(directory, 'bin/pairlobby')});
    expect(managedInstall(join(directory, 'checkout/packages/cli/dist/main.js'))).toBeNull();
    writeFileSync(join(directory, 'bin/pairlobby'), '#!/bin/sh\nexec something-else\n');
    expect(managedInstall(entry)).toBeNull();
});

test('test_an_update_installs_beside_the_old_release_and_moves_the_launcher', async () => {
    const entry = installCurrent();
    const archive = packRelease('9.0.0');
    const checksum = createHash('sha256').update(archive).digest('hex');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new Response(url.endsWith('.sha256') ? `${checksum}  pairlobby-cli-9.0.0.tgz\n` : archive)));
    const installed = await installRelease(latest('9.0.0'), managedInstall(entry)!);
    expect(installed).toBe(join(directory, 'install/releases', `9.0.0-${checksum.slice(0, 12)}`));
    expect(readFileSync(join(directory, 'bin/pairlobby'), 'utf8')).toContain(join(installed, 'dist/main.mjs'));
    expect(readFileSync(entry, 'utf8')).toBe('');
});

test('test_a_tampered_update_changes_nothing', async () => {
    const entry = installCurrent();
    const before = readFileSync(join(directory, 'bin/pairlobby'), 'utf8');
    const archive = packRelease('9.0.0');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new Response(url.endsWith('.sha256') ? `${'0'.repeat(64)}  x.tgz\n` : archive)));
    await expect(installRelease(latest('9.0.0'), managedInstall(entry)!)).rejects.toThrow('checksum');
    const wrongVersion = packRelease('8.0.0');
    const checksum = createHash('sha256').update(wrongVersion).digest('hex');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new Response(url.endsWith('.sha256') ? `${checksum}  x.tgz\n` : wrongVersion)));
    await expect(installRelease(latest('9.0.0'), managedInstall(entry)!)).rejects.toThrow('does not match');
    expect(readFileSync(join(directory, 'bin/pairlobby'), 'utf8')).toBe(before);
});

test('test_settings_decide_whether_to_check_offer_or_remind', () => {
    const store = new LocalStore(join(directory, 'data'));
    writeUpdateState(store, {checkedAt: Date.now(), latest: latest('9.0.0')});
    expect(shouldOfferUpdate(store)?.version).toBe('9.0.0');
    expect(updateNotice(store)).toContain('pairlobby update');

    writeUpdateState(store, {skipped: '9.0.0'});
    expect(shouldOfferUpdate(store)).toBeNull();
    expect(updateNotice(store)).toBeNull();

    writeUpdateState(store, {skipped: null});
    store.setSettings({autoUpdate: true});
    expect(shouldOfferUpdate(store)).toBeNull();
    writeUpdateState(store, {installed: '9.0.0'});
    expect(updateNotice(store)).toContain('installed in the background');
    expect(readUpdateState(store).installed).toBeNull();

    store.setSettings({updateCheck: false});
    expect(updateNotice(store)).toBeNull();
    writeUpdateState(store, {checkedAt: 0});
    scheduleBackgroundCheck(store, 'rooms');
    expect(readUpdateState(store).checkedAt).toBe(0);
});

test('test_an_old_no_choice_is_not_migrated_into_an_explicit_skip', () => {
    const store = new LocalStore(join(directory, 'legacy'));
    mkdirSync(store.directory, {recursive: true});
    writeFileSync(join(store.directory, 'update.json'), JSON.stringify({checkedAt: Date.now(), latest: latest('9.0.0'), dismissed: '9.0.0', installed: null, lastError: null}));
    expect(readUpdateState(store).skipped).toBeNull();
    expect(shouldOfferUpdate(store)?.version).toBe('9.0.0');
    writeUpdateState(store, {lastError: null});
    expect(readFileSync(join(store.directory, 'update.json'), 'utf8')).not.toContain('dismissed');
});

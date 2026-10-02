//! Updates from GitHub releases of PairLobby/app.
//!
//! A release publishes `pairlobby-cli-<version>.tgz` and its `.sha256`. Checking
//! reads the latest release at most once a day, in a detached process so no
//! command waits on the network. Installing mirrors the website installer: verify
//! the checksum and package, unpack into its own `releases/` folder, then swap
//! the launcher in one rename. Running terminals and receivers keep the version
//! they started with; new ones use the update.

import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, platform} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

import type {LocalStore} from '@pairlobby/client';

import release from './release.json' with {type: 'json'};

export const UPDATE_REPOSITORY = 'PairLobby/app';
const CHECK_INTERVAL_MS = 24 * 3600_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LAUNCHER_MARKER = 'PairLobby managed launcher';

export type LatestRelease = {
    version: string;
    tag: string;
    pageUrl: string;
    archiveUrl: string;
    checksumUrl: string;
};

export type UpdateState = {
    checkedAt: number;
    latest: LatestRelease | null;
    /** A version not to offer or mention again: declined when asked, or already installed. */
    dismissed: string | null;
    /** A version installed in the background, reported once by the next command. */
    installed: string | null;
    lastError: string | null;
};

export type UpdateCheck = {
    current: string;
    latest: LatestRelease | null;
    available: boolean;
    checkedAt: number;
};

export type ManagedInstall = {
    root: string;
    launcher: string;
};

export type InstallOptions = {
    say?: (line: string) => void;
};

const EMPTY_STATE: UpdateState = {checkedAt: 0, latest: null, dismissed: null, installed: null, lastError: null};

export function currentVersion(): string {
    return release.version;
}

function parts(version: string): {numbers: number[]; prerelease: string | null} {
    const [core, ...rest] = version.split('-');
    return {numbers: core!.split('.').map(Number), prerelease: rest.length ? rest.join('-') : null};
}

/** Semantic version order; a prerelease sorts before its release. */
export function compareVersions(left: string, right: string): number {
    const a = parts(left);
    const b = parts(right);
    for (let index = 0; index < 3; index++) {
        const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
        if (difference !== 0) {
            return Math.sign(difference);
        }
    }
    if (a.prerelease === b.prerelease) {
        return 0;
    }
    if (a.prerelease === null || b.prerelease === null) {
        return a.prerelease === null ? 1 : -1;
    }
    return a.prerelease.localeCompare(b.prerelease, 'en', {numeric: true});
}

function apiBase(): string {
    const url = new URL(process.env['PAIRLOBBY_UPDATE_API'] ?? `https://api.github.com/repos/${UPDATE_REPOSITORY}`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw new Error('The update source must use HTTPS');
    }
    return url.href.replace(/\/+$/, '');
}

type GitHubAsset = {name?: unknown; browser_download_url?: unknown};

type GitHubRelease = {tag_name?: unknown; html_url?: unknown; assets?: GitHubAsset[]; draft?: unknown; prerelease?: unknown};

/** The latest published release, or null when there is none with installable assets. */
export async function fetchLatestRelease(): Promise<LatestRelease | null> {
    let response: Response;
    try {
        response = await fetch(`${apiBase()}/releases/latest`, {headers: {accept: 'application/vnd.github+json', 'user-agent': `pairlobby/${currentVersion()}`}, signal: AbortSignal.timeout(10_000)});
    } catch {
        throw new Error('Could not reach GitHub to check for updates');
    }
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(response.status === 403 || response.status === 429 ? 'GitHub is rate limiting update checks; try again later' : `GitHub answered ${response.status} when checking for updates`);
    }
    const data = (await response.json()) as GitHubRelease;
    if (typeof data.tag_name !== 'string' || data.draft === true || data.prerelease === true) {
        return null;
    }
    const version = data.tag_name.replace(/^v/, '');
    if (!VERSION_PATTERN.test(version)) {
        return null;
    }
    const asset = (name: string) => data.assets?.find((entry) => entry.name === name)?.browser_download_url;
    const archiveUrl = asset(`pairlobby-cli-${version}.tgz`);
    const checksumUrl = asset(`pairlobby-cli-${version}.tgz.sha256`);
    if (typeof archiveUrl !== 'string' || typeof checksumUrl !== 'string') {
        return null;
    }
    return {version, tag: data.tag_name, pageUrl: typeof data.html_url === 'string' ? data.html_url : `https://github.com/${UPDATE_REPOSITORY}/releases`, archiveUrl, checksumUrl};
}

function stateFile(store: LocalStore): string {
    return join(store.directory, 'update.json');
}

export function readUpdateState(store: LocalStore): UpdateState {
    try {
        return {...EMPTY_STATE, ...(JSON.parse(readFileSync(stateFile(store), 'utf8')) as Partial<UpdateState>)};
    } catch {
        return {...EMPTY_STATE};
    }
}

export function writeUpdateState(store: LocalStore, update: Partial<UpdateState>): UpdateState {
    const next = {...readUpdateState(store), ...update};
    mkdirSync(store.directory, {recursive: true, mode: 0o700});
    const temporary = `${stateFile(store)}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {mode: 0o600});
    renameSync(temporary, stateFile(store));
    return next;
}

/** Uses the day-old answer unless `force`; a failed check keeps the previous answer. */
export async function checkForUpdate(store: LocalStore, force = false): Promise<UpdateCheck> {
    const state = readUpdateState(store);
    if (!force && Date.now() - state.checkedAt < CHECK_INTERVAL_MS) {
        return {current: currentVersion(), latest: state.latest, available: isNewer(state.latest), checkedAt: state.checkedAt};
    }
    try {
        const latest = await fetchLatestRelease();
        const saved = writeUpdateState(store, {checkedAt: Date.now(), latest, lastError: null});
        return {current: currentVersion(), latest, available: isNewer(latest), checkedAt: saved.checkedAt};
    } catch (error) {
        writeUpdateState(store, {checkedAt: Date.now(), lastError: error instanceof Error ? error.message : String(error)});
        throw error;
    }
}

function isNewer(latest: LatestRelease | null): boolean {
    return latest !== null && compareVersions(latest.version, currentVersion()) > 0;
}

function defaultInstallRoot(): string {
    return resolve(process.env['PAIRLOBBY_INSTALL_DIR'] ?? (platform() === 'win32' ? join(process.env['LOCALAPPDATA'] ?? homedir(), 'PairLobby') : join(homedir(), '.local/share/pairlobby')));
}

function defaultLauncher(root: string): string {
    const windows = platform() === 'win32';
    const bin = resolve(process.env['PAIRLOBBY_BIN_DIR'] ?? (windows ? join(root, 'bin') : join(homedir(), '.local/bin')));
    return join(bin, windows ? 'pairlobby.cmd' : 'pairlobby');
}

/**
 * The installer's layout when this process runs from it: `<root>/releases/<id>/dist/main.mjs`
 * behind a managed launcher. A checkout or npm link is not ours to replace, so it returns null.
 */
export function managedInstall(entry = process.argv[1] ?? ''): ManagedInstall | null {
    let path: string;
    try {
        path = realpathSync(entry);
    } catch {
        return null;
    }
    const releaseDirectory = dirname(dirname(path));
    if (basename(path) !== 'main.mjs' || basename(dirname(path)) !== 'dist' || basename(dirname(releaseDirectory)) !== 'releases') {
        return null;
    }
    const root = dirname(dirname(releaseDirectory));
    const expected = defaultInstallRoot();
    if (realpathOr(root) !== realpathOr(expected)) {
        return null;
    }
    const launcher = defaultLauncher(root);
    try {
        if (!readFileSync(launcher, 'utf8').includes(LAUNCHER_MARKER)) {
            return null;
        }
    } catch {
        return null;
    }
    return {root, launcher};
}

function realpathOr(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

async function download(url: string): Promise<Buffer> {
    if (!url.startsWith('https://') && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
        throw new Error('Refusing a release download that is not HTTPS');
    }
    let response: Response;
    try {
        // GitHub serves release assets through a redirect to its download host.
        response = await fetch(url, {headers: {'user-agent': `pairlobby/${currentVersion()}`}, redirect: 'follow', signal: AbortSignal.timeout(120_000)});
    } catch {
        throw new Error('Could not download the PairLobby release');
    }
    if (!response.ok) {
        throw new Error(`Downloading the PairLobby release failed (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function bundledSkills(root: string): Set<string> {
    const contents = new Set<string>();
    const releases = join(root, 'releases');
    for (const entry of existsSync(releases) ? readdirSync(releases, {withFileTypes: true}) : []) {
        if (!entry.isDirectory()) {
            continue;
        }
        try {
            contents.add(readFileSync(join(releases, entry.name, 'skills/pairlobby/SKILL.md'), 'utf8'));
        } catch {
            // A release without a bundled skill has nothing to compare.
        }
    }
    return contents;
}

/** Refreshes agent skills that still match a skill an earlier release installed; edited ones are left alone. */
function refreshSkills(root: string, skill: string, say: (line: string) => void): void {
    const known = bundledSkills(root);
    const homes = {claude: join(homedir(), '.claude'), codex: process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), qwen: join(homedir(), '.qwen')};
    for (const [agent, home] of Object.entries(homes)) {
        const target = join(home, 'skills/pairlobby/SKILL.md');
        let current: string;
        try {
            current = readFileSync(target, 'utf8');
        } catch {
            continue;
        }
        if (current === skill || !known.has(current)) {
            continue;
        }
        writeFileSync(`${target}.backup-${Date.now()}`, current, {mode: 0o600});
        writeFileSync(target, skill, {mode: 0o600});
        say(`Updated the ${agent} skill.`);
    }
}

/** Installs a release next to the current one and points the launcher at it. */
export async function installRelease(latest: LatestRelease, install: ManagedInstall, options: InstallOptions = {}): Promise<string> {
    const say = options.say ?? (() => {});
    say(`Downloading PairLobby ${latest.version}…`);
    const [archive, sums] = await Promise.all([download(latest.archiveUrl), download(latest.checksumUrl)]);
    const expected = sums.toString().trim().split(/\s+/)[0] ?? '';
    if (!/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(archive).digest('hex') !== expected) {
        throw new Error('The downloaded release failed its checksum; nothing was changed');
    }
    mkdirSync(install.root, {recursive: true});
    const work = mkdtempSync(join(install.root, '.update-'));
    try {
        const packed = join(work, 'app.tgz');
        writeFileSync(packed, archive);
        const tar = platform() === 'win32' ? 'tar.exe' : 'tar';
        const entries = execFileSync(tar, ['-tzf', packed], {encoding: 'utf8'}).trim().split('\n');
        if (entries.some((path) => !path.startsWith('package/') || path.split(/[\\/]/).includes('..'))) {
            throw new Error('The downloaded release has unexpected contents; nothing was changed');
        }
        execFileSync(tar, ['-xzf', packed, '-C', work]);
        const packageRoot = join(work, 'package');
        const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {name?: string; version?: string};
        if (metadata.name !== '@pairlobby/cli' || metadata.version !== latest.version) {
            throw new Error('The downloaded package does not match the release; nothing was changed');
        }
        const reported = execFileSync(process.execPath, [join(packageRoot, 'dist/main.mjs'), '--version'], {encoding: 'utf8'});
        if (!reported.startsWith(`PairLobby ${latest.version} `)) {
            throw new Error('The downloaded CLI reports an unexpected version; nothing was changed');
        }
        const releaseDirectory = join(install.root, 'releases', `${latest.version}-${expected.slice(0, 12)}`);
        mkdirSync(join(install.root, 'releases'), {recursive: true});
        if (!existsSync(releaseDirectory)) {
            renameSync(packageRoot, releaseDirectory);
        }
        refreshSkills(install.root, readFileSync(join(releaseDirectory, 'skills/pairlobby/SKILL.md'), 'utf8'), say);
        const entry = join(releaseDirectory, 'dist/main.mjs');
        const windows = platform() === 'win32';
        const launcher = windows ? `@echo off\r\nrem ${LAUNCHER_MARKER}\r\n"${process.execPath}" "${entry}" %*\r\n` : `#!/bin/sh\n# ${LAUNCHER_MARKER}\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`;
        const pending = join(dirname(install.launcher), `.pairlobby-${process.pid}.tmp`);
        writeFileSync(pending, launcher, {mode: 0o755});
        chmodSync(pending, 0o755);
        renameSync(pending, install.launcher);
        return releaseDirectory;
    } finally {
        rmSync(work, {recursive: true, force: true});
    }
}

const NEVER_CHECK = new Set(['update', 'receiver-run', 'receiver-tools', 'channel', 'guard-stop']);

/** Starts a detached day-old check (and install, with auto-update) without delaying this command. */
export function scheduleBackgroundCheck(store: LocalStore, command: string): void {
    const settings = store.settings();
    if (!settings.updateCheck || NEVER_CHECK.has(command) || process.env['PAIRLOBBY_NO_UPDATE_CHECK'] === '1' || process.env['CI']) {
        return;
    }
    if (Date.now() - readUpdateState(store).checkedAt < CHECK_INTERVAL_MS) {
        return;
    }
    // Record the attempt first, so a burst of commands starts one check rather than one each.
    writeUpdateState(store, {checkedAt: Date.now()});
    try {
        const child = spawn(process.execPath, [process.argv[1]!, 'update', '--background'], {detached: true, stdio: 'ignore', env: {...process.env, PAIRLOBBY_DATA_DIR: store.directory}});
        child.on('error', () => {});
        child.unref();
    } catch {
        // An update check is never worth failing the command it rode along with.
    }
}

/** The detached half: refresh the answer and, with auto-update on, install it. */
export async function runBackgroundUpdate(store: LocalStore): Promise<void> {
    const check = await checkForUpdate(store, true).catch(() => null);
    if (!check?.available || !check.latest || !store.settings().autoUpdate) {
        return;
    }
    const install = managedInstall();
    if (!install) {
        return;
    }
    try {
        await installRelease(check.latest, install);
        writeUpdateState(store, {installed: check.latest.version, lastError: null});
    } catch (error) {
        writeUpdateState(store, {lastError: error instanceof Error ? error.message : String(error)});
    }
}

/** A one-line reminder for a person at a terminal, or null when there is nothing new. */
export function updateNotice(store: LocalStore): string | null {
    if (!store.settings().updateCheck) {
        return null;
    }
    const state = readUpdateState(store);
    if (state.installed && compareVersions(state.installed, currentVersion()) > 0) {
        writeUpdateState(store, {installed: null});
        return `PairLobby ${state.installed} was installed in the background; new terminals use it.`;
    }
    if (!isNewer(state.latest) || state.dismissed === state.latest!.version) {
        return null;
    }
    return `PairLobby ${state.latest!.version} is available (you have ${currentVersion()}). Run: pairlobby update`;
}

/** Whether to ask now: a newer release this person has not already declined, and nothing installing it for them. */
export function shouldOfferUpdate(store: LocalStore): LatestRelease | null {
    const settings = store.settings();
    const state = readUpdateState(store);
    if (!settings.updateCheck || settings.autoUpdate || !isNewer(state.latest) || state.dismissed === state.latest!.version) {
        return null;
    }
    return state.latest;
}

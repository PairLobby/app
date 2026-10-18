//! Keeps this device's relay running on its own. On macOS a LaunchAgent starts
//! `pairlobby serve` at login and again whenever it stops, so the relay belongs to
//! no terminal or agent session. It runs the installed release through the
//! installer's launcher, so `pairlobby update` moves the relay along with the CLI.

import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, platform} from 'node:os';
import {join} from 'node:path';

import {installedLauncher} from './updater.js';

export const SERVICE_LABEL = 'com.pairlobby.relay';

export type ServiceLayout = {label: string; plist: string; log: string; domain: string};
export type ServiceProgram = {args: string[]; followsUpdates: boolean};
export type ServiceSettings = {port: number; host?: string | undefined; environment: Record<string, string>};
export type RelayProbe = {answering: boolean; version: string | null};
export type ServiceStatus = {installed: boolean; loaded: boolean; pid: number | null; program: string[]; followsUpdates: boolean; relay: RelayProbe; url: string; log: string};
export type ServiceRefresh = {restarted: boolean; reason: string};

/** Where the agent lives. `PAIRLOBBY_SERVICE_LABEL` gives tests their own agent beside the real one. */
export function serviceLayout(): ServiceLayout {
    const label = process.env['PAIRLOBBY_SERVICE_LABEL'] || SERVICE_LABEL;
    const home = homedir();
    return {
        label,
        plist: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
        log: join(home, 'Library', 'Logs', 'PairLobby', label === SERVICE_LABEL ? 'relay.log' : `${label}.log`),
        domain: `gui/${process.getuid?.() ?? 0}`,
    };
}

export function requireServicePlatform(): void {
    if (platform() !== 'darwin') {
        throw new Error('pairlobby service runs the relay as a macOS LaunchAgent; other systems are not supported yet. Run pairlobby serve under your own supervisor, or on Windows use npm run service from a checkout.');
    }
}

/**
 * What the agent runs: the installer's launcher when there is one, which always
 * points at the current release. Otherwise this exact build, which stays put
 * until the service is installed again.
 */
export function serviceProgram(launcher = installedLauncher(), entry = process.argv[1] ?? ''): ServiceProgram {
    if (launcher) {
        return {args: [launcher], followsUpdates: true};
    }
    return {args: [process.execPath, realpathSync(entry)], followsUpdates: false};
}

function xml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function servicePlist(layout: ServiceLayout, program: ServiceProgram, settings: ServiceSettings): string {
    // Without --host the relay follows `pairlobby settings network-sharing` each time it starts.
    const args = [...program.args, 'serve', '--port', String(settings.port), ...(settings.host ? ['--host', settings.host] : [])];
    const environment = Object.entries(settings.environment).map(([key, value]) => `        <key>${xml(key)}</key><string>${xml(value)}</string>`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${xml(layout.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((arg) => `        <string>${xml(arg)}</string>`).join('\n')}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environment.join('\n')}
    </dict>
    <key>RunAtLoad</key><true/>
    <!-- Always: a relay stopped by SIGTERM exits cleanly, and that must not keep it down. uninstall is how to stop it. -->
    <key>KeepAlive</key><true/>
    <!-- Without this, a port clash becomes a restart loop several times a second. -->
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>${xml(layout.log)}</string>
    <key>StandardErrorPath</key><string>${xml(layout.log)}</string>
    <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

/** The program an installed agent runs, read back from its plist; also recognises one written by the old repository script. */
export function plistProgram(plist: string): string[] {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? '';
    return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => match[1]!.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
}

/** Any HTTP answer means something is listening; only a refused or timed-out connection means the relay is down. */
export async function probeRelay(url: string): Promise<RelayProbe> {
    try {
        const response = await fetch(`${url}/v1/server`, {signal: AbortSignal.timeout(2000)});
        const info = response.ok ? await response.json().catch(() => ({})) as {version?: unknown} : {};
        return {answering: true, version: typeof info.version === 'string' ? info.version : null};
    } catch {
        return {answering: false, version: null};
    }
}

function launchctl(args: string[]): string {
    return execFileSync('launchctl', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
}

function loadedPid(layout: ServiceLayout): {loaded: boolean; pid: number | null} {
    try {
        const printed = launchctl(['print', `${layout.domain}/${layout.label}`]);
        const pid = /^\s*pid = (\d+)/m.exec(printed)?.[1];
        return {loaded: true, pid: pid ? Number(pid) : null};
    } catch {
        return {loaded: false, pid: null};
    }
}

export function serviceInstalled(layout = serviceLayout()): boolean {
    return platform() === 'darwin' && existsSync(layout.plist);
}

/** The port an installed agent's relay listens on; the old repository script's launcher always used 8790. */
export function servicePort(program: string[]): number {
    const index = program.indexOf('--port');
    return index >= 0 ? Number(program[index + 1]) : 8790;
}

/** Whether the installed agent is the one that keeps a relay on this port running. */
export function serviceCovers(port: number, layout = serviceLayout()): boolean {
    return serviceInstalled(layout) && servicePort(plistProgram(readFileSync(layout.plist, 'utf8'))) === port;
}

export async function serviceStatus(port: number, layout = serviceLayout()): Promise<ServiceStatus> {
    const url = `http://127.0.0.1:${port}`;
    const installed = existsSync(layout.plist);
    const program = installed ? plistProgram(readFileSync(layout.plist, 'utf8')) : [];
    const launcher = installedLauncher();
    return {installed, ...loadedPid(layout), program, followsUpdates: launcher !== null && program[0] === launcher, relay: await probeRelay(url), url, log: layout.log};
}

async function waitForRelay(url: string, seconds: number): Promise<RelayProbe> {
    let probe: RelayProbe = {answering: false, version: null};
    for (let attempt = 0; attempt < seconds * 4; attempt++) {
        probe = await probeRelay(url);
        if (probe.answering) {
            return probe;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return probe;
}

export async function installService(settings: ServiceSettings, program = serviceProgram(), layout = serviceLayout()): Promise<ServiceStatus> {
    mkdirSync(join(layout.plist, '..'), {recursive: true});
    mkdirSync(join(layout.log, '..'), {recursive: true});
    const pending = `${layout.plist}.${process.pid}.tmp`;
    writeFileSync(pending, servicePlist(layout, program, settings), {mode: 0o644});
    renameSync(pending, layout.plist);
    try {
        launchctl(['bootout', `${layout.domain}/${layout.label}`]);
    } catch {
        // Not loaded yet.
    }
    launchctl(['bootstrap', layout.domain, layout.plist]);
    await waitForRelay(`http://127.0.0.1:${settings.port}`, 10);
    return serviceStatus(settings.port, layout);
}

export function uninstallService(layout = serviceLayout()): boolean {
    const existed = existsSync(layout.plist);
    try {
        launchctl(['bootout', `${layout.domain}/${layout.label}`]);
    } catch {
        // Already unloaded.
    }
    rmSync(layout.plist, {force: true});
    return existed;
}

export async function restartService(port: number, layout = serviceLayout()): Promise<ServiceStatus> {
    if (!existsSync(layout.plist)) {
        throw new Error('The relay service is not installed. Install it with: pairlobby service install');
    }
    if (!loadedPid(layout).loaded) {
        launchctl(['bootstrap', layout.domain, layout.plist]);
    } else {
        launchctl(['kickstart', '-k', `${layout.domain}/${layout.label}`]);
    }
    await waitForRelay(`http://127.0.0.1:${port}`, 10);
    return serviceStatus(port, layout);
}

/** After an update: restart the relay so it runs the new release, but only an agent that follows the launcher. */
export async function refreshService(port: number, layout = serviceLayout()): Promise<ServiceRefresh> {
    if (!serviceInstalled(layout)) {
        return {restarted: false, reason: 'not installed'};
    }
    const program = plistProgram(readFileSync(layout.plist, 'utf8'));
    if (program[0] !== installedLauncher()) {
        return {restarted: false, reason: `it runs ${program.join(' ')}, not the installed release; reinstall it with pairlobby service install`};
    }
    await restartService(port, layout);
    return {restarted: true, reason: 'restarted on the new release'};
}

export function serviceLog(lines: number, layout = serviceLayout()): string {
    try {
        return readFileSync(layout.log, 'utf8').split('\n').slice(-lines - 1).join('\n');
    } catch {
        return '';
    }
}

export function formatServiceStatus(status: ServiceStatus, cliVersion: string): string {
    const lines = [`service  ${status.installed ? status.loaded ? `installed and loaded${status.pid ? ` (pid ${status.pid})` : ', not running right now'}` : 'installed but not loaded; run pairlobby service restart' : 'not installed; pairlobby service install keeps the relay running at login and after a crash'}`];
    if (status.installed) {
        lines.push(`runs     ${status.program.join(' ')}`);
        if (!status.followsUpdates) {
            lines.push('         this is not the installed release, so updates do not reach the relay; pairlobby service install fixes that');
        }
    }
    if (status.installed && status.loaded && status.pid === null && status.relay.answering) {
        lines.push('         another process holds the port, such as a relay started from a terminal or agent session; when it stops, the service takes over within 10 seconds');
    }
    if (!status.relay.answering) {
        lines.push(`relay    not answering on ${status.url}`);
    } else if (status.relay.version === null) {
        lines.push(`relay    answering on ${status.url}, an older build that does not report its version (this CLI is ${cliVersion}); pairlobby service restart updates it`);
    } else if (status.relay.version !== cliVersion) {
        lines.push(`relay    answering on ${status.url}, version ${status.relay.version} while this CLI is ${cliVersion}; pairlobby service restart updates it`);
    } else {
        lines.push(`relay    answering on ${status.url}, version ${status.relay.version}`);
    }
    lines.push(`log      ${status.log}`);
    return lines.join('\n');
}

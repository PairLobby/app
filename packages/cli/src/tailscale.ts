//! What the Tailscale client on this device knows: this device's MagicDNS names
//! and its peers. Absent, stopped or logged-out Tailscale yields null, never an
//! error, because every caller treats Tailscale as optional.

import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';

export type TailscaleDevice = {
    /** The device's short name, such as `h` or `desktop-hjoncour`. */
    name: string;
    /** Its MagicDNS name without the trailing dot, or empty when MagicDNS is off. */
    dnsName: string;
    addresses: string[];
    online: boolean;
    os: string;
};

export type TailscaleView = {
    self: TailscaleDevice;
    peers: TailscaleDevice[];
};

type StatusNode = {HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; OS?: string};

type StatusJson = {BackendState?: string; Self?: StatusNode; Peer?: Record<string, StatusNode>};

/** Where the CLI usually lives when it is not on PATH. `PAIRLOBBY_TAILSCALE` names another. */
const INSTALLED: Partial<Record<NodeJS.Platform, string[]>> = {
    darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
    win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
};

function binaries(): string[] {
    const override = process.env['PAIRLOBBY_TAILSCALE'];
    if (override) {
        return [override];
    }
    return ['tailscale', ...(INSTALLED[process.platform] ?? []).filter((path) => existsSync(path))];
}

function run(binary: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(binary, ['status', '--json'], {timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024}, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

function device(node: StatusNode): TailscaleDevice {
    const dnsName = (node.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    // The MagicDNS label first: some devices, such as iPhones, report their HostName as localhost.
    return {name: (dnsName.split('.')[0] || node.HostName || '').toLowerCase(), dnsName, addresses: node.TailscaleIPs ?? [], online: node.Online ?? false, os: node.OS ?? ''};
}

/** Parses `tailscale status --json`; null unless Tailscale is up and logged in. */
export function parseTailscaleStatus(text: string): TailscaleView | null {
    let status: StatusJson;
    try {
        status = JSON.parse(text) as StatusJson;
    } catch {
        return null;
    }
    if (status.BackendState !== 'Running' || !status.Self) {
        return null;
    }
    return {self: device(status.Self), peers: Object.values(status.Peer ?? {}).map(device)};
}

export async function tailscaleView(timeoutMs = 2000): Promise<TailscaleView | null> {
    for (const binary of binaries()) {
        try {
            return parseTailscaleStatus(await run(binary, timeoutMs));
        } catch {
            // Not installed under this name, not running, or too slow: try the next.
        }
    }
    return null;
}

/** The names other tailnet devices may use for this one: its MagicDNS name and the short form. */
export function tailscaleNames(view: TailscaleView | null): string[] {
    if (!view?.self.dnsName) {
        return [];
    }
    return [...new Set([view.self.dnsName, view.self.dnsName.split('.')[0]!])];
}

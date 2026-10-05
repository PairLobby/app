//! Who may reach a relay that listens beyond loopback, and how relays on one
//! local network find each other over mDNS (Bonjour), so a device can join with a
//! bare invite code. mDNS does not cross Tailscale; the CLI asks Tailscale for
//! its peers separately.

import {hostname, networkInterfaces} from 'node:os';

import makeMdns from 'multicast-dns';

/** Where this device's relay accepts connections from. */
export type RelayNetwork = 'off' | 'tailscale' | 'lan';

export const RELAY_SERVICE = '_pairlobby._tcp.local';

function plainAddress(address: string): string {
    return address.toLowerCase().replace(/^::ffff:/, '');
}

/** Tailscale assigns addresses from 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(address: string): boolean {
    const plain = plainAddress(address);
    const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(plain);
    if (v4) {
        return Number(v4[1]) === 100 && (Number(v4[2]) & 0xc0) === 64;
    }
    return plain.startsWith('fd7a:115c:a1e0:');
}

export function isLoopbackAddress(address: string): boolean {
    const plain = plainAddress(address);
    return plain === '::1' || plain.startsWith('127.');
}

/**
 * This device, a private or link-local network address, or a Tailscale address:
 * what may join a room by name when the room allows it. A request through a proxy
 * arrives from the proxy, so a public URL in front of the relay is judged by the
 * proxy's address; keep such rooms closed to the local network.
 */
export function isLocalNetworkAddress(address: string): boolean {
    const plain = plainAddress(address);
    if (isLoopbackAddress(plain) || isTailscaleAddress(plain)) {
        return true;
    }
    const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(plain);
    if (v4) {
        const [first, second] = [Number(v4[1]), Number(v4[2])];
        return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
    }
    return /^f[cd][0-9a-f]{2}:/.test(plain) || /^fe[89ab][0-9a-f]:/.test(plain);
}

/** This machine's non-internal IPv4 addresses, optionally only its Tailscale ones. */
export function ownAddresses(tailscaleOnly = false): string[] {
    return Object.values(networkInterfaces()).flatMap((addresses) => (addresses ?? []).filter((address) => address.family === 'IPv4' && !address.internal && (!tailscaleOnly || isTailscaleAddress(address.address))).map((address) => address.address));
}

function localName(): string {
    const name = hostname().replace(/\.local$/i, '').replace(/[^A-Za-z0-9-]/g, '-') || 'pairlobby';
    return `${name}.local`;
}

/**
 * Answers mDNS queries for PairLobby relays with this relay's port and current
 * LAN addresses. Returns a function that stops answering.
 */
export function advertiseRelay(port: number): () => void {
    let mdns: ReturnType<typeof makeMdns>;
    try {
        mdns = makeMdns();
    } catch {
        return () => {};
    }
    const target = localName();
    const instance = `PairLobby ${target.slice(0, -'.local'.length)} ${port}.${RELAY_SERVICE}`;
    mdns.on('error', () => {});
    mdns.on('query', (query) => {
        if (!(query.questions ?? []).some((question) => question.name.toLowerCase() === RELAY_SERVICE && ['PTR', 'ANY'].includes(String(question.type)))) {
            return;
        }
        const addresses = ownAddresses().filter((address) => !isTailscaleAddress(address));
        if (addresses.length === 0) {
            return;
        }
        mdns.respond({
            answers: [{name: RELAY_SERVICE, type: 'PTR', ttl: 120, data: instance}],
            additionals: [
                {name: instance, type: 'SRV', ttl: 120, data: {port, target, priority: 0, weight: 0}},
                {name: instance, type: 'TXT', ttl: 120, data: ['v=1']},
                ...addresses.map((address) => ({name: target, type: 'A' as const, ttl: 120, data: address})),
            ],
        });
    });
    return () => mdns.destroy();
}

/** Relay addresses announced on the local network within `timeoutMs`, as `http://ip:port` URLs. */
export function browseRelays(timeoutMs = 1500, signal?: AbortSignal): Promise<string[]> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve([]);
            return;
        }
        let mdns: ReturnType<typeof makeMdns>;
        try {
            mdns = makeMdns();
        } catch {
            resolve([]);
            return;
        }
        const found = new Set<string>();
        mdns.on('error', () => {});
        mdns.on('response', (response) => {
            const records = [...(response.answers ?? []), ...(response.additionals ?? [])];
            for (const record of records) {
                if (record.type !== 'SRV' || !record.name.toLowerCase().endsWith(RELAY_SERVICE)) {
                    continue;
                }
                const {port, target} = record.data;
                for (const address of records) {
                    if (address.type === 'A' && address.name.toLowerCase() === target.toLowerCase()) {
                        found.add(`http://${address.data}:${port}`);
                    }
                }
            }
        });
        let done = false;
        const finish = () => {
            if (!done) {
                done = true;
                clearTimeout(deadline);
                signal?.removeEventListener('abort', finish);
                mdns.destroy();
                resolve([...found]);
            }
        };
        const deadline = setTimeout(finish, timeoutMs);
        signal?.addEventListener('abort', finish, {once: true});
        // macOS refuses multicast (EHOSTUNREACH) to an app without the Local Network
        // permission; nothing can answer then, so stop waiting.
        const ask = () => mdns.query({questions: [{name: RELAY_SERVICE, type: 'PTR'}]}, (error) => {
            if (error) {
                finish();
            }
        });
        ask();
        // Like other mDNS clients, ask twice: the first query can leave before a responder is listening.
        setTimeout(() => {
            if (!done) {
                ask();
            }
        }, Math.min(400, timeoutMs / 2)).unref();
    });
}

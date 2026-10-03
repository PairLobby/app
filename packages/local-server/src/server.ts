//! The local relay. Bridges `node:http` to the shared Web-standard router, so
//! local and hosted operation run the same request handling.

import {createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {mkdirSync} from 'node:fs';
import {hostname, networkInterfaces} from 'node:os';
import {dirname} from 'node:path';

import {RoomService, createRouter} from '@pairlobby/server-core';

import {advertiseRelay, isLocalNetworkAddress, isLoopbackAddress, isTailscaleAddress} from './network.js';
import {SqliteRoomStore} from './sqlite-store.js';

export interface ServeOptions {
    host?: string;
    port?: number;
    dataFile: string;
    /** Origins a browser page may call from. Empty means no browser may call this server at all. */
    allowedOrigins?: string[];
    /** Address to advertise in invitations when the server sits behind Tailscale or another proxy. */
    publicUrl?: string;
    /** Who may connect: anyone who can reach the address (default), or only this device and its Tailscale peers. */
    peers?: 'any' | 'tailscale';
    /** More names this server answers to beyond its own addresses and hostname, such as Tailscale MagicDNS names. */
    hostnames?: string[];
    /** Announce this relay on the local network over mDNS, so `pairlobby join <code>` there can find it. */
    advertise?: boolean;
}

export interface RunningServer {
    url: string;
    /** Addresses other devices can join through; empty when the server only listens on this device. */
    shareUrls: string[];
    /** Whether `pairlobby join <code>` on another device can find this server without --server. */
    discoverable: boolean;
    host: string;
    port: number;
    dataFile: string;
    close(): Promise<void>;
}

/** The port a relay listens on unless told otherwise, and the one other devices try when searching a tailnet. */
export const DEFAULT_PORT = 8790;

export function startServer(options: ServeOptions): Promise<RunningServer> {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? DEFAULT_PORT;
    mkdirSync(dirname(options.dataFile), {recursive: true});
    const store = new SqliteRoomStore(options.dataFile);
    const service = new RoomService(store);

    // Loopback is not authentication: a page in the user's browser can reach it too.
    // Host is pinned to defeat DNS rebinding, and an unexpected Origin is refused.
    // A server listening on every interface also answers to this machine's own
    // addresses and names; a rebinding attack needs a name the attacker controls.
    const allowedHosts: string[] = [];
    if (options.publicUrl) {
        allowedHosts.push(new URL(options.publicUrl).host);
    }
    const wildcard = isWildcard(host);
    let boundPort = port;
    const tailscaleOnly = options.peers === 'tailscale';
    const extraNames = (options.hostnames ?? []).map((name) => name.toLowerCase());
    const acceptHost = (value: string) => allowedHosts.includes(value) || (!isLoopback(host) && isOwnHost(value, boundPort, extraNames));
    // Found by mDNS when advertised, or by a tailnet device trying the default port on this one's Tailscale address.
    const discoverable = () => !options.publicUrl && !isLoopback(host) && (options.advertise === true || (boundPort === DEFAULT_PORT && (wildcard || isTailscaleAddress(host))));
    const serverInfo = () => ({shareUrls: shareUrls(host, boundPort, options.publicUrl, tailscaleOnly), discoverable: discoverable()});
    const inviteProbe = async (prefix: string) => store.hasInviteDigestPrefix(prefix);
    // Where each request's connection came from, read off the socket: no header can claim it.
    const peerAddresses = new WeakMap<Request, string>();
    const peerIsLocal = (request: Request) => isLocalNetworkAddress(peerAddresses.get(request) ?? '');
    const localRooms = async (name: string) => store.localJoinRooms(name);
    const route = createRouter({service, allowedOrigins: options.allowedOrigins ?? [], allowedHosts: acceptHost, serverInfo, inviteProbe, peerIsLocal, localRooms});

    // One local relay owns this store. Serialize mutating requests so two
    // async service calls cannot both choose the same next event sequence.
    let mutations: Promise<unknown> = Promise.resolve();

    // One timer for the whole relay, aimed at the earliest auto-close deadline. Sweeps
    // join the write queue, and every write re-plans it, so a changed policy or a new
    // message moves the wake-up instead of leaving a stale one to fire.
    let wake: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const plan = (at: number | null): void => {
        clearTimeout(wake);
        wake = undefined;
        if (stopped || at === null) {
            return;
        }
        wake = setTimeout(sweep, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
        wake.unref();
    };
    const sweep = (): void => {
        mutations = mutations
            .then(async () => {
                const result = await service.closeDueRooms();
                plan(result.more ? Date.now() : result.nextAt);
            })
            .catch(() => plan(Date.now() + 60_000));
    };

    const handle = (request: Request): Promise<Response> => {
        const result = mutations.then(() => route(request));
        if (!['GET', 'HEAD'].includes(request.method)) {
            mutations = result.catch(() => {});
            sweep();
        }
        return result;
    };
    sweep();

    const server = createHttpServer((incoming, outgoing) => {
        void respond(handle, incoming, outgoing, `http://${incoming.headers.host ?? `${host}:${port}`}`, peerAddresses);
    });
    // Enforced on the connection, before any request is read: the bind address alone
    // cannot say "Tailscale only" when the Tailscale address may not exist yet at boot.
    server.on('connection', (socket) => {
        if (!peerAllowed(options.peers ?? 'any', socket.remoteAddress ?? '')) {
            socket.destroy();
        }
    });
    let stopAdvertising = () => {};

    return new Promise<RunningServer>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            // Port 0 asks the OS to choose, so the bound port is the only truthful one to report.
            const address = server.address();
            boundPort = typeof address === 'object' && address !== null ? address.port : port;
            allowedHosts.push(`${host}:${boundPort}`, `localhost:${boundPort}`, `127.0.0.1:${boundPort}`);
            if (options.advertise && !isLoopback(host)) {
                stopAdvertising = advertiseRelay(boundPort);
            }
            resolve({
                url: options.publicUrl ?? `http://${wildcard ? '127.0.0.1' : host}:${boundPort}`,
                shareUrls: shareUrls(host, boundPort, options.publicUrl, tailscaleOnly),
                discoverable: discoverable(),
                host,
                port: boundPort,
                dataFile: options.dataFile,
                close: () => {
                    stopped = true;
                    clearTimeout(wake);
                    stopAdvertising();
                    return mutations.then(() => shutdown(server, store));
                }
            });
        });
    });
}

function isWildcard(host: string): boolean {
    return host === '0.0.0.0' || host === '::';
}

function isLoopback(host: string): boolean {
    return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

/** Names and addresses that belong to this machine right now; interfaces come and go with Wi-Fi and DHCP. */
function ownHostnames(): Set<string> {
    const names = new Set<string>();
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            names.add(address.family === 'IPv6' ? `[${address.address.toLowerCase()}]` : address.address);
        }
    }
    const machine = hostname().toLowerCase();
    names.add(machine);
    names.add(machine.endsWith('.local') ? machine.slice(0, -'.local'.length) : `${machine}.local`);
    return names;
}

/** Whether a connection from `address` may reach a relay limited to `peers`. */
export function peerAllowed(peers: 'any' | 'tailscale', address: string): boolean {
    return peers === 'any' || isLoopbackAddress(address) || isTailscaleAddress(address);
}

function isOwnHost(value: string, port: number, extraNames: string[]): boolean {
    let parsed: URL;
    try {
        parsed = new URL(`http://${value}`);
    } catch {
        return false;
    }
    const name = parsed.hostname.toLowerCase();
    return (parsed.port === '' ? 80 : Number(parsed.port)) === port && (ownHostnames().has(name) || extraNames.includes(name));
}

function shareUrls(host: string, port: number, publicUrl: string | undefined, tailscaleOnly: boolean): string[] {
    if (publicUrl) {
        return [publicUrl.replace(/\/+$/, '')];
    }
    if (isLoopback(host)) {
        return [];
    }
    if (!isWildcard(host)) {
        return [`http://${host.includes(':') ? `[${host}]` : host}:${port}`];
    }
    // IPv4 only: link-local IPv6 needs a zone id that another device cannot use as written.
    const urls: string[] = [];
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal && (!tailscaleOnly || isTailscaleAddress(address.address))) {
                urls.push(`http://${address.address}:${port}`);
            }
        }
    }
    return urls;
}

async function respond(handle: (request: Request) => Promise<Response>, incoming: IncomingMessage, outgoing: ServerResponse, origin: string, peerAddresses: WeakMap<Request, string>): Promise<void> {
    try {
        const request = await toRequest(incoming, origin);
        peerAddresses.set(request, incoming.socket.remoteAddress ?? '');
        const response = await handle(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch {
        outgoing.writeHead(503, {'content-type': 'application/json'});
        outgoing.end(JSON.stringify({error: {code: 'server_unavailable', message: 'the server could not complete this request'}}));
    }
}

async function toRequest(incoming: IncomingMessage, origin: string): Promise<Request> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const method = incoming.method ?? 'GET';
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) {
            continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const hasBody = method !== 'GET' && method !== 'HEAD' && chunks.length > 0;
    return new Request(new URL(incoming.url ?? '/', origin), {method, headers, ...(hasBody ? {body: Buffer.concat(chunks)} : {})});
}

function shutdown(server: Server, store: SqliteRoomStore): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => {
            store.close();
            resolve();
        });
        server.closeAllConnections?.();
    });
}

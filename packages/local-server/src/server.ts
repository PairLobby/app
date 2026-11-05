//! The Node relay: an adapter between `node:http` and the shared kernel (`createRelay`).
//! It supplies one write queue for its one store, a timer for auto-close, and what the
//! socket says about each caller; every protocol rule stays in the kernel.

import {createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {mkdirSync} from 'node:fs';
import {hostname, networkInterfaces} from 'node:os';
import {dirname} from 'node:path';

import {ChangeNotifier, NotifyingStore, RoomService, createAdmission, createRelay, memoryRateLimiter, queueExecutor, timerScheduler} from '@pairlobby/server-core';
import type {AdmissionLimits, DiscoveryDocument, Relay, RelayAccount, RelayMember, RequestContext} from '@pairlobby/server-core';
import {ABSOLUTE_MAX_FILE_BYTES, DEFAULT_ROOM_POLICY} from '@pairlobby/protocol';
import type {ReceiptMode, RoomPolicy} from '@pairlobby/protocol';

import {advertiseRelay, isLocalNetworkAddress, isLoopbackAddress, isTailscaleAddress} from './network.js';
import {REQUEST_ID_HEADER, requestIdFor, requestLogLine, shouldLog} from './request-log.js';
import {restoreLatest, startBackups} from './backup.js';
import type {BackupSchedule, BackupScheduleOptions, RestoreResult} from './backup.js';
import type {RequestLogOptions} from './request-log.js';
import type {RelayDiscovery} from './settings.js';
import {MembersFile} from './members.js';
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
    /** Exact `Host` values to accept as well, such as an internal DNS name a load balancer forwards unchanged. */
    allowedHosts?: string[];
    /** Announce this relay on the local network over mDNS, so `pairlobby join <code>` there can find it. */
    advertise?: boolean;
    /** Reported by `GET /v1/server`, so a client can tell which build this relay runs. */
    version?: string;
    /** When set, creating a room needs this token; joining with an invite never does. Read it from the environment, never a command line. */
    createToken?: string;
    /**
     * Personal tokens: the members file, reread when it changes. Each token creates rooms like the
     * create token, logs in as its member, and names that member on the rooms they create and join.
     */
    members?: {file: string; log?: (line: string) => void; reloadMs?: number};
    /** False when the create token no longer logs people in, beside personal tokens. */
    teamTokenLogin?: boolean;
    /**
     * The header a load balancer in front of this relay puts the caller's address in, such as
     * `x-forwarded-for`. Only set it when every request comes through that proxy: a caller
     * reaching the relay directly could write the header themselves.
     */
    trustedProxyHeader?: string;
    /**
     * Treat every caller that reaches this relay through its proxy as being on the local network, so rooms
     * opened to the network can be found and joined by name. Only for a proxy that is itself the access gate.
     */
    proxyIsAccessGate?: boolean;
    /** Rate limits on creating rooms and redeeming invites; callers on this device are exempt unless the relay is behind a proxy. */
    limits?: Partial<AdmissionLimits>;
    /** Caps for rooms created from now on, over the built-in defaults; rooms that already exist keep theirs. */
    roomLimits?: Partial<RoomPolicy>;
    /**
     * Serve `GET /.well-known/pairlobby.json`, and with `loginMode: 'token'` (which needs
     * `createToken` or `members`) the token check `GET /api/online/account`. Absent serves neither.
     */
    discovery?: RelayDiscovery;
    /** How plain receipts are kept: `both` (default) until every client in use reads watermarks, then `watermark`. */
    receiptMode?: ReceiptMode;
    /** One JSON line per request for a log collector; absent logs nothing. */
    requestLog?: RequestLogOptions;
    /** Copies the database while it runs and once more on close; on a disk with no database, the newest copy is restored first unless `restore` is false. */
    backup?: BackupScheduleOptions & {restore?: boolean};
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
    /** What happened to the backup on start, when backups are on. */
    restore?: RestoreResult;
    /** Rereads the members file now, as on `SIGHUP`; nothing when there is none. */
    reloadMembers(): void;
    close(): Promise<void>;
}

/** Non-file endpoints retain the smaller bound; the file-upload route may use the explicit file ceiling. */
const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

class RequestBodyTooLarge extends Error {}

function requestBodyLimit(incoming: IncomingMessage): number {
    const path = (incoming.url ?? '').split('?', 1)[0];
    return incoming.method === 'POST' && /^\/v1\/rooms\/[^/]+\/files$/.test(path ?? '') ? ABSOLUTE_MAX_FILE_BYTES : DEFAULT_MAX_REQUEST_BYTES;
}

/** The discovery document: `relays` empty means "this origin", and `features` are only what this relay really has. */
function discoveryDocument(settings: RelayDiscovery, publicUrl: string | undefined, files: boolean, members: boolean): DiscoveryDocument {
    return {
        version: 1,
        ...(settings.name ? {name: settings.name} : {}),
        login: settings.loginMode === 'token' ? {mode: 'token', ...(settings.loginHelp ? {tokenHelp: settings.loginHelp} : {}), verify: '/api/online/account', ...(members ? {members: true} : {})} : {mode: 'none'},
        relays: publicUrl ? [publicUrl] : [],
        features: ['message-stages', ...(files ? ['files'] : [])],
        ...(settings.supportUrl ? {support: settings.supportUrl} : {})
    };
}

/** How often the relay deletes listings whose room or agent is gone; readers skip them already. */
const DIRECTORY_SWEEP_MS = 60 * 60_000;

/** The port a relay listens on unless told otherwise, and the one other devices try when searching a tailnet. */
export const DEFAULT_PORT = 8790;

export async function startServer(options: ServeOptions): Promise<RunningServer> {
    mkdirSync(dirname(options.dataFile), {recursive: true});
    const backup = options.backup;
    // Starting empty while the rooms sit in an unreachable backup would bury them under new copies.
    const restore = backup && backup.restore !== false ? await restoreLatest({target: backup.target, dataFile: options.dataFile, ...(backup.log ? {log: backup.log} : {})}).catch((error: unknown) => {
        throw new Error(`could not restore the rooms from ${backup.target.description}: ${error instanceof Error ? error.message : String(error)}. Fix access to it, or start with --no-restore to begin empty.`);
    }) : undefined;
    return listen(options, restore);
}

function listen(options: ServeOptions, restore: RestoreResult | undefined): Promise<RunningServer> {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? DEFAULT_PORT;
    const store = new SqliteRoomStore(options.dataFile);
    // Every write goes through this one process, so it can wake the reads waiting on a room.
    const changes = new ChangeNotifier();
    const service = new RoomService(new NotifyingStore(store, changes), undefined, undefined, {...DEFAULT_ROOM_POLICY, ...options.roomLimits}, {...(options.receiptMode ? {receiptMode: options.receiptMode} : {}), memberDefault: store.directory.memberDefault});

    // Loopback is not authentication: a page in the user's browser can reach it too.
    // Host is pinned to defeat DNS rebinding, and an unexpected Origin is refused.
    // A server listening on every interface also answers to this machine's own
    // addresses and names; a rebinding attack needs a name the attacker controls.
    const allowedHosts: string[] = [...(options.allowedHosts ?? [])];
    if (options.publicUrl) {
        allowedHosts.push(new URL(options.publicUrl).host);
    }
    const wildcard = isWildcard(host);
    let boundPort = port;
    const tailscaleOnly = options.peers === 'tailscale';
    const extraNames = (options.hostnames ?? []).map((name) => name.toLowerCase());
    const acceptHost = (value: string) => allowedHosts.includes(value) || (!isLoopback(host) && isOwnHost(value, boundPort, extraNames));
    // Found by mDNS when advertised, or by a tailnet device trying the default port on this one's Tailscale address.
    // Behind a proxy every caller arrives from the proxy's address, which looks local, so the
    // socket can no longer vouch that a caller is on this network.
    const behindProxy = Boolean(options.publicUrl || options.trustedProxyHeader);
    if (options.proxyIsAccessGate && !behindProxy) {
        throw new Error('proxyIsAccessGate needs publicUrl or trustedProxyHeader: it says the proxy in front of the relay lets only the right callers through');
    }
    const discoverable = () => !behindProxy && !isLoopback(host) && (options.advertise === true || (boundPort === DEFAULT_PORT && (wildcard || isTailscaleAddress(host))));
    const serverInfo = () => ({shareUrls: shareUrls(host, boundPort, options.publicUrl, tailscaleOnly), discoverable: discoverable(), ...(options.version ? {version: options.version} : {})});
    const inviteProbe = async (prefix: string) => store.hasInviteDigestPrefix(prefix);
    const peerIsLocal = (_request: Request, context: RequestContext) => isLocalNetworkAddress(context.peerAddress ?? '');
    // On a relay with personal tokens, a room is listed only to the members who see it.
    const localRooms = async (name?: string, member?: RelayMember | null) => {
        const rooms = store.localJoinRooms(name);
        const seen = await Promise.all(rooms.map(async (room) => {
            const record = (await store.loadRoom(room.roomId))?.room;
            return record !== undefined && service.sees(record, member?.handle);
        }));
        return rooms.filter((_, index) => seen[index]);
    };
    const exempt = (_request: Request, context: RequestContext) => !behindProxy && isLoopbackAddress(context.peerAddress ?? '');
    if (options.discovery?.loginMode === 'token' && !options.createToken && !options.members) {
        throw new Error('token-mode login needs a create token or a members file: they are the tokens people log in with');
    }
    if (options.members && options.discovery?.loginMode !== 'token') {
        throw new Error('a members file needs token-mode login: it is how people log in with their own tokens');
    }
    const members = options.members ? new MembersFile({path: options.members.file, ...(options.members.log ? {log: options.members.log} : {}), ...(options.members.reloadMs ? {reloadMs: options.members.reloadMs} : {})}) : null;
    const admission = createAdmission({...(options.createToken ? {createToken: options.createToken} : {}), ...(members ? {members: members.lookup} : {}), ...(options.teamTokenLogin === false ? {teamTokenLogin: false} : {}), limiter: memoryRateLimiter(), ...(options.limits ? {limits: options.limits} : {}), ...(options.trustedProxyHeader ? {trustedProxyHeader: options.trustedProxyHeader} : {}), exempt});
    const discovery = options.discovery ? discoveryDocument(options.discovery, options.publicUrl, store.files !== undefined, members !== null) : undefined;
    // The room address a login leads to: the advertised one, else the address the caller used.
    const accountCheck = options.discovery?.loginMode === 'token' ? (request: Request, member: RelayMember | null): RelayAccount => {
        const account = {email: null, name: options.discovery?.name ?? null, server: options.publicUrl ?? new URL(request.url).origin};
        return member ? {...account, userId: `member:${member.handle}`, handle: member.handle} : {...account, userId: 'team', handle: null};
    } : undefined;
    // One store behind one process: one queue keeps two writes from choosing the same next event sequence.
    const executor = queueExecutor();
    // One timer for the whole relay, aimed at the earliest auto-close deadline; every write plans it again.
    const scheduler = timerScheduler(() => void relay.tick('auto-close'));
    const relay: Relay = createRelay({service, executor, scheduler, behindProxy, ...(options.proxyIsAccessGate ? {proxyIsAccessGate: true} : {}), allowedOrigins: options.allowedOrigins ?? [], allowedHosts: acceptHost, serverInfo, changes, inviteProbe, peerIsLocal, localRooms, admission, directory: store.directory, ...(members ? {memberByHandle: members.byHandle} : {}), ...(discovery ? {discovery: () => discovery} : {}), ...(accountCheck ? {accountCheck} : {})});
    void relay.tick('auto-close');
    const sweep = members ? setInterval(() => void relay.tick('directory-sweep').catch(() => {}), DIRECTORY_SWEEP_MS) : undefined;
    sweep?.unref();

    const health = JSON.stringify({service: 'pairlobby-relay', ready: true, ...(options.version ? {version: options.version} : {})});
    const server = createHttpServer((incoming, outgoing) => {
        // Answered before the Host check and the write queue: a load balancer probes by address, and a busy relay is still alive.
        if (incoming.method === 'GET' && (incoming.url ?? '').split('?', 1)[0] === '/health') {
            outgoing.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
            outgoing.end(health);
            return;
        }
        void respond(relay, incoming, outgoing, `http://${incoming.headers.host ?? `${host}:${port}`}`, options.requestLog);
    });
    // Enforced on the connection, before any request is read: the bind address alone
    // cannot say "Tailscale only" when the Tailscale address may not exist yet at boot.
    server.on('connection', (socket) => {
        if (!peerAllowed(options.peers ?? 'any', socket.remoteAddress ?? '')) {
            socket.destroy();
        }
    });
    let stopAdvertising = () => {};
    let backups: BackupSchedule | null = null;

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
            backups = options.backup ? startBackups({...options.backup, source: store, dataFile: options.dataFile}) : null;
            members?.start();
            resolve({
                url: options.publicUrl ?? `http://${wildcard ? '127.0.0.1' : host}:${boundPort}`,
                shareUrls: shareUrls(host, boundPort, options.publicUrl, tailscaleOnly),
                discoverable: discoverable(),
                host,
                port: boundPort,
                dataFile: options.dataFile,
                ...(restore ? {restore} : {}),
                reloadMembers: () => members?.reload(true),
                close: () => {
                    members?.stop();
                    clearInterval(sweep);
                    scheduler.stop();
                    changes.close();
                    stopAdvertising();
                    return executor.idle().then(() => shutdown(server, store, backups));
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

async function respond(relay: Relay, incoming: IncomingMessage, outgoing: ServerResponse, origin: string, log: RequestLogOptions | undefined): Promise<void> {
    const started = Date.now();
    const requestId = requestIdFor(typeof incoming.headers[REQUEST_ID_HEADER] === 'string' ? incoming.headers[REQUEST_ID_HEADER] : null);
    const bodyLimit = requestBodyLimit(incoming);
    const finish = (status: number, headers: Record<string, string>, body?: Buffer | string) => {
        outgoing.writeHead(status, {...headers, [REQUEST_ID_HEADER]: requestId});
        outgoing.end(body);
        const method = incoming.method ?? 'GET';
        if (log && shouldLog(log.mode, method, status)) {
            log.write(requestLogLine({requestId, method, path: (incoming.url ?? '/').split('?', 1)[0]!, status, ms: Date.now() - started, at: new Date(started)}));
        }
    };
    const tooLarge = () => finish(413, {'content-type': 'application/json', connection: 'close'}, JSON.stringify({error: {code: 'payload_too_large', message: 'this request is larger than the relay accepts'}}));
    try {
        if (Number(incoming.headers['content-length'] ?? 0) > bodyLimit) {
            tooLarge();
            return;
        }
        const request = await toRequest(incoming, origin, bodyLimit);
        // Read off the socket: no header can claim where the connection came from.
        const response = await relay.handle(request, {peerAddress: incoming.socket.remoteAddress ?? ''});
        finish(response.status, Object.fromEntries(response.headers), response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
        if (error instanceof RequestBodyTooLarge) {
            tooLarge();
            return;
        }
        finish(503, {'content-type': 'application/json'}, JSON.stringify({error: {code: 'server_unavailable', message: 'the server could not complete this request'}}));
    }
}

async function toRequest(incoming: IncomingMessage, origin: string, bodyLimit: number): Promise<Request> {
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of incoming) {
        received += (chunk as Buffer).byteLength;
        if (received > bodyLimit) {
            throw new RequestBodyTooLarge();
        }
        chunks.push(chunk as Buffer);
    }
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

/** Stops taking requests, takes the last backup, then closes the database. */
function shutdown(server: Server, store: SqliteRoomStore, backups: BackupSchedule | null): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => {
            void (backups?.stop() ?? Promise.resolve()).finally(() => {
                store.close();
                resolve();
            });
        });
        server.closeAllConnections?.();
    });
}

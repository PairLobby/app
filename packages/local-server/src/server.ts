//! The local relay. Bridges `node:http` to the shared Web-standard router, so
//! local and hosted operation run the same request handling.

import {createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

import {RoomService, createRouter} from '@pairlobby/server-core';

import {SqliteRoomStore} from './sqlite-store.js';

export interface ServeOptions {
    host?: string;
    port?: number;
    dataFile: string;
    /** Origins a browser page may call from. Empty means no browser may call this server at all. */
    allowedOrigins?: string[];
    /** Address to advertise in invitations when the server sits behind Tailscale or another proxy. */
    publicUrl?: string;
}

export interface RunningServer {
    url: string;
    host: string;
    port: number;
    dataFile: string;
    close(): Promise<void>;
}

export function startServer(options: ServeOptions): Promise<RunningServer> {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 8790;
    mkdirSync(dirname(options.dataFile), {recursive: true});
    const store = new SqliteRoomStore(options.dataFile);
    const service = new RoomService(store);

    // Loopback is not authentication: a page in the user's browser can reach it too.
    // Host is pinned to defeat DNS rebinding, and an unexpected Origin is refused.
    const allowedHosts: string[] = [];
    if (options.publicUrl) allowedHosts.push(new URL(options.publicUrl).host);
    const handle = createRouter({service, allowedOrigins: options.allowedOrigins ?? [], allowedHosts});

    const server = createHttpServer((incoming, outgoing) => {
        void respond(handle, incoming, outgoing, `http://${incoming.headers.host ?? `${host}:${port}`}`);
    });

    return new Promise<RunningServer>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            // Port 0 asks the OS to choose, so the bound port is the only truthful one to report.
            const address = server.address();
            const boundPort = typeof address === 'object' && address !== null ? address.port : port;
            allowedHosts.push(`${host}:${boundPort}`, `localhost:${boundPort}`, `127.0.0.1:${boundPort}`);
            resolve({
                url: options.publicUrl ?? `http://${host}:${boundPort}`,
                host,
                port: boundPort,
                dataFile: options.dataFile,
                close: () => shutdown(server, store),
            });
        });
    });
}

async function respond(handle: (request: Request) => Promise<Response>, incoming: IncomingMessage, outgoing: ServerResponse, origin: string): Promise<void> {
    try {
        const response = await handle(await toRequest(incoming, origin));
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
        if (value === undefined) continue;
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

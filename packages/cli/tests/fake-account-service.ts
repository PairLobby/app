//! A stand-in for the hosted account service, for tests that run the real CLI.
//!
//! It answers the account routes the CLI calls and puts a real local relay behind
//! one hosted relay path, so a room "on someone else's workspace" behaves like a
//! room. Joining by account is translated into an ordinary invite redemption.

import {createServer} from 'node:http';
import type {IncomingMessage, Server} from 'node:http';
import type {AddressInfo} from 'node:net';

import {PairLobbyClient} from '@pairlobby/client';
import type {RunningServer} from '@pairlobby/local-server';

export type FakeInvitation = {id: string; roomId: string; roomName: string; invitedBy: string; role: 'member' | 'guest'; agents: number; createdAt: number; expiresAt: number};

export type FakeRoomInvitation = {id: string; handle: string; role: 'member' | 'guest'; agents: number; state: 'pending' | 'accepted'; createdAt: number; expiresAt: number};

export type FakeAccountService = {
    origin: string;
    /** The hosted relay path that fronts `relay`. */
    server: string;
    /** Unanswered invitations for the logged-in account. */
    invitations: FakeInvitation[];
    /** Rooms the account accepted, by room id, with the owner's credential the fake joins through. */
    accepted: Map<string, {name: string; controllerCredential: string}>;
    /** Invitations created through the relay path, by room id. */
    roomInvitations: Map<string, FakeRoomInvitation[]>;
    handles: Set<string>;
    handle: string | null;
    /** Every request as `METHOD path`, with whether it carried the account token. */
    calls: {request: string; token: boolean}[];
    close: () => Promise<void>;
};

const RELAY_PATH = '/relay/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002';

async function read(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeAccountService(relay: RunningServer, token = 'test-account-token'): Promise<FakeAccountService> {
    const state: FakeAccountService = {origin: '', server: '', invitations: [], accepted: new Map(), roomInvitations: new Map(), handles: new Set(['maria', 'joe']), handle: null, calls: [], close: async () => {}};
    const server: Server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', state.origin);
        const body = await read(request);
        const authed = request.headers['x-pairlobby-account-token'] === token;
        state.calls.push({request: `${request.method} ${url.pathname}`, token: authed});
        const send = (status: number, value: unknown) => {
            response.writeHead(status, {'content-type': 'application/json'});
            response.end(JSON.stringify(value));
        };
        const fail = (status: number, message: string) => send(status, {error: {code: status === 401 ? 'unauthorized' : 'invalid_request', message}});
        try {
            if (url.pathname.startsWith('/api/online/')) {
                if (!authed) {
                    return fail(401, 'Run pairlobby login first');
                }
                if (url.pathname === '/api/online/account') {
                    return send(200, {email: 'hugo@example.com', userId: 'user-1', server: state.server, handle: state.handle});
                }
                if (url.pathname === '/api/online/handle' && request.method === 'PUT') {
                    const handle = String((JSON.parse(body) as {handle?: unknown}).handle ?? '').replace(/^@/, '').toLowerCase();
                    if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(handle)) {
                        return fail(400, 'A handle is 3–30 characters: lowercase letters, digits, - and _, starting with a letter or digit');
                    }
                    if (state.handles.has(handle)) {
                        return fail(409, 'That handle is not available');
                    }
                    state.handle = handle;
                    return send(200, {handle});
                }
                if (url.pathname === '/api/online/invitations') {
                    return send(200, {invitations: state.invitations});
                }
                if (url.pathname === '/api/online/rooms') {
                    const shared = [];
                    for (const [roomId, room] of state.accepted) {
                        const snapshot = await new PairLobbyClient(relay.url).snapshot(roomId, room.controllerCredential);
                        shared.push({roomId, name: snapshot.name, createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt, lifecycle: snapshot.lifecycle, private: true, owner: false, participants: [], latestSeq: snapshot.latestSeq, server: state.server});
                    }
                    return send(200, {server: state.server, rooms: [], shared});
                }
                const decision = /^\/api\/online\/invitations\/([^/]+)\/(accept|decline)$/.exec(url.pathname);
                if (decision && request.method === 'POST') {
                    const invitation = state.invitations.find((candidate) => candidate.id === decision[1]);
                    if (!invitation) {
                        return fail(404, 'Invitation not found; it may have expired or been withdrawn');
                    }
                    state.invitations = state.invitations.filter((candidate) => candidate !== invitation);
                    return send(200, decision[2] === 'decline' ? {ok: true} : {roomId: invitation.roomId, roomName: invitation.roomName, role: invitation.role, server: state.server});
                }
                return fail(404, 'Unknown account endpoint');
            }
            if (!url.pathname.startsWith(`${RELAY_PATH}/v1/`)) {
                return fail(404, 'Endpoint not found');
            }
            const path = url.pathname.slice(RELAY_PATH.length);
            const invitations = /^\/v1\/rooms\/([^/]+)\/invitations(?:\/([^/]+))?$/.exec(path);
            if (invitations) {
                const list = state.roomInvitations.get(invitations[1]!) ?? [];
                if (request.method === 'GET') {
                    return send(200, {invitations: list});
                }
                if (request.method === 'DELETE') {
                    state.roomInvitations.set(invitations[1]!, list.filter((candidate) => candidate.id !== invitations[2]));
                    return send(200, {ok: true});
                }
                if (!authed) {
                    return fail(401, 'Inviting by handle needs an account login; run pairlobby login');
                }
                const input = JSON.parse(body) as {handle?: string; role?: string};
                const handle = String(input.handle ?? '').replace(/^@/, '').toLowerCase();
                if (!state.handles.has(handle)) {
                    return fail(404, `No account has the handle @${handle}`);
                }
                const created: FakeRoomInvitation = {id: `inv-${list.length + 1}`, handle, role: input.role === 'observer' ? 'guest' : 'member', agents: 1, state: 'pending', createdAt: 1_700_000_000_000, expiresAt: 1_700_604_800_000};
                state.roomInvitations.set(invitations[1]!, [created, ...list]);
                return send(201, {invitation: created});
            }
            const accountJoin = /^\/v1\/rooms\/([^/]+)\/account-join$/.exec(path);
            if (accountJoin && request.method === 'POST') {
                const room = state.accepted.get(accountJoin[1]!);
                if (!authed || !room) {
                    return fail(403, 'Your account is not allowed in this room; ask its owner for an invite');
                }
                const code = (await new PairLobbyClient(relay.url).mintInvite(accountJoin[1]!, room.controllerCredential, 'member', false)).code;
                const redeemed = await fetch(`${relay.url}/v1/invites/redeem`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({...(JSON.parse(body) as object), code, useInviteName: false})});
                response.writeHead(redeemed.status, {'content-type': 'application/json'});
                return response.end(await redeemed.text());
            }
            // Everything else on the relay path is the room's own protocol.
            const headers = new Headers();
            for (const [name, value] of Object.entries(request.headers)) {
                if (typeof value === 'string' && !['host', 'connection', 'content-length', 'x-pairlobby-account-token'].includes(name)) {
                    headers.set(name, value);
                }
            }
            const forwarded = await fetch(`${relay.url}${path}${url.search}`, {method: request.method ?? 'GET', headers, ...(body ? {body} : {})});
            response.writeHead(forwarded.status, {'content-type': forwarded.headers.get('content-type') ?? 'application/json'});
            response.end(forwarded.status === 204 ? undefined : await forwarded.text());
        } catch (error) {
            fail(503, error instanceof Error ? error.message : String(error));
        }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    state.server = state.origin + RELAY_PATH;
    state.close = () => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
    });
    return state;
}

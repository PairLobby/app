//! Transport-agnostic routing over Web `Request`/`Response`, so the Node server
//! and the Cloudflare Worker share one implementation of the HTTP contract.

import {
    INVITE_PROBE_LENGTH,
    CreateInviteRequest,
    CreateRoomRequest,
    PROTOCOL_VERSION,
    PROTOCOL_VERSION_HEADER,
    FileId,
    MAX_EVENT_WAIT_MS,
    ProtocolError,
    ReadEventsQuery,
    RedeemInviteRequest,
    JoinAsGuestRequest,
    LocalJoinRequest,
    RoomId,
    SetLocalJoinRequest,
    RenameRoomRequest,
    RenameSelfRequest,
    SendEventRequest,
    SetAccessRequest,
    SetInviteRoleRequest,
    SetAutoCloseRequest,
    SetLockedRequest,
    SetMutedRequest,
    SetPermissionsRequest,
    SetRoleRequest,
    TurnClaimRequest,
    TurnTokenRequest,
    TurnModeRequest,
    TurnActionRequest,
    ResolveRequestRequest,
    ProviderWaitRequest,
    SetExpiryRequest,
    ControlRequest
} from '@pairlobby/protocol';
import type {ErrorCode, LiveTransport, LocalRoom, ProviderWait, RelayLimits, ServerDescription} from '@pairlobby/protocol';

import type {Admission} from './admission.js';
import type {ChangeNotifier} from './changes.js';
import type {RoomService} from './service.js';

export interface RouterOptions {
    service: RoomService;
    /**
     * Exact origins a browser may call from. A CLI sends no `Origin`, so an
     * unexpected one means a web page is talking to us — including a malicious
     * page reaching for loopback.
     */
    allowedOrigins?: string[];
    /** `Host` values to accept, defeating DNS rebinding against a local server. */
    allowedHosts?: string[] | ((host: string) => boolean);
    /** What only the adapter knows for `GET /v1/server`: its share addresses and its build. Every relay answers the path. */
    serverInfo?: () => ServerInfo;
    /**
     * Wakes held reads. Present means the relay offers long-poll: `GET .../events?wait=` waits for a change
     * instead of answering empty. Only a relay whose writes all pass through one process can offer it.
     */
    changes?: ChangeNotifier;
    /**
     * How clients hear about new events, when the relay knows. Defaults to `long-poll` with `changes` and is
     * otherwise left out, so a client keeps its own rule; a relay with a socket hub says `websocket`.
     */
    transport?: LiveTransport;
    /** Features beyond those the router can see for itself. */
    features?: string[];
    /**
     * Answers `GET /v1/invites/probe?prefix=`: whether any invite this server issued
     * has a digest starting with that prefix. Lets a client on the same network find
     * the relay behind a bare code; absent means the path is unknown.
     */
    inviteProbe?: (prefix: string) => Promise<boolean>;
    /**
     * Whether this request came from the relay's own device, its local network or its
     * tailnet. Only a transport that sees the connection's real address can say; absent
     * means never, so joining by name is refused.
     */
    peerIsLocal?: (request: Request) => boolean;
    /** Open rooms that allow local joins, matching a name or all of them; answers `GET /v1/rooms/local[?name=]`. */
    localRooms?: (name?: string) => Promise<LocalRoom[]>;
    /** The create token and rate limits; absent means anyone who reaches the relay may create rooms and try codes freely. */
    admission?: Admission;
    /** Answers `GET /.well-known/pairlobby.json`, which tells `pairlobby setup` who this relay is and how to log in. */
    discovery?: () => DiscoveryDocument;
    /**
     * Token-mode login: answers `GET /api/online/account` for a caller holding the team
     * token (the create token). Absent means the path is unknown. Needs `admission`.
     */
    accountCheck?: (request: Request) => TeamAccount;
}

/** What a deployment says about itself to `pairlobby setup`. */
export interface DiscoveryDocument {
    version: 1;
    name?: string;
    login: {mode: 'token' | 'none'; tokenHelp?: string; verify?: string};
    relays: string[];
    features: string[];
    support?: string;
}

/** The account a team token stands for: no person, just where its rooms go. */
export interface TeamAccount {
    email: null;
    userId: 'team';
    name: string | null;
    server: string;
    handle: null;
}

export interface ServerInfo {
    /** Addresses other devices can use to reach this server; empty when it only listens on this device. */
    shareUrls: string[];
    /** True when a device on the same network or tailnet can find this server from an invite code alone. */
    discoverable?: boolean;
    /** The relay's own version, so a client can tell when it runs an older build than the CLI. */
    version?: string;
}

const JSON_HEADERS = {'content-type': 'application/json; charset=utf-8', [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION)};

export function createRouter(options: RouterOptions): (request: Request) => Promise<Response> {
    const {service} = options;

    return async function handle(request: Request): Promise<Response> {
        try {
            const guard = checkHeaders(request, options);
            if (guard) {
                return guard;
            }
            if (request.method.toUpperCase() === 'GET' && new URL(request.url).pathname === '/v1/server') {
                return json(describe(options));
            }
            if (options.inviteProbe && request.method.toUpperCase() === 'GET' && new URL(request.url).pathname === '/v1/invites/probe') {
                const prefix = new URL(request.url).searchParams.get('prefix') ?? '';
                if (!new RegExp(`^[0-9a-f]{${INVITE_PROBE_LENGTH}}$`).test(prefix)) {
                    return errorResponse('invalid_request', `prefix must be ${INVITE_PROBE_LENGTH} lowercase hex digits`, 400);
                }
                return json({known: await options.inviteProbe(prefix)});
            }
            const path = new URL(request.url).pathname;
            if (options.discovery && request.method.toUpperCase() === 'GET' && path === '/.well-known/pairlobby.json') {
                return new Response(JSON.stringify(options.discovery()), {status: 200, headers: {...JSON_HEADERS, 'cache-control': 'public, max-age=300'}});
            }
            if (options.accountCheck && options.admission && request.method.toUpperCase() === 'GET' && path === '/api/online/account') {
                await options.admission.beforeAccountCheck(request);
                return json(options.accountCheck(request));
            }
            const local = await routeLocal(request, options);
            if (local) {
                return local;
            }
            return await route(request, service, options.admission, options.changes);
        } catch (error) {
            if (error instanceof ProtocolError) {
                return errorResponse(error.code, error.message, error.httpStatus, error.details);
            }
            if (isSchemaError(error)) {
                return errorResponse('invalid_request', 'the request body did not match the protocol schema', 400);
            }
            return errorResponse('server_unavailable', 'the server could not complete this request', 503);
        }
    };
}

const NOT_LOCAL = 'joining by name is only open to devices on this relay\'s local network or tailnet; ask for an invite code';

/** Finding and joining rooms by name: both need a transport that vouches the caller is local. */
async function routeLocal(request: Request, options: RouterOptions): Promise<Response | null> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const method = request.method.toUpperCase();
    const lookup = method === 'GET' && segments.length === 3 && segments[0] === 'v1' && segments[1] === 'rooms' && segments[2] === 'local';
    const join = method === 'POST' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'rooms' && segments[3] === 'local-join';
    if (!lookup && !join) {
        return null;
    }
    if (lookup && !options.localRooms) {
        return errorResponse('invalid_request', 'unknown path', 404);
    }
    if (!options.peerIsLocal?.(request)) {
        return errorResponse('unauthorized', NOT_LOCAL, 401);
    }
    if (lookup) {
        // No name at all lists every room open to the local network, for the room list.
        if (!url.searchParams.has('name')) {
            return json({rooms: await options.localRooms!()});
        }
        const name = (url.searchParams.get('name') ?? '').trim();
        if (name.length === 0 || name.length > 64) {
            return errorResponse('invalid_request', 'name must be 1–64 characters', 400);
        }
        return json({rooms: await options.localRooms!(name)});
    }
    const roomId = RoomId.parse(segments[2]);
    const input = LocalJoinRequest.parse(await request.json());
    const result = await options.service.joinOnLocalNetwork(roomId, input);
    return json({roomId: result.roomId, participantId: result.participantId, role: result.role, room: result.snapshot});
}

/** The relay's own account of itself, from what this router was given: nothing is claimed that it was not. */
export function describe(options: RouterOptions): ServerDescription {
    const profile = options.service.relayProfile();
    const features = [
        ...(profile.files ? ['files'] : []),
        ...(options.peerIsLocal && options.localRooms ? ['local-join'] : []),
        ...(options.inviteProbe ? ['invite-probe'] : []),
        ...(options.admission?.createTokenRequired ? ['create-token'] : []),
        ...(options.accountCheck && options.admission ? ['token-login'] : []),
        ...(options.features ?? [])
    ];
    const transport = options.transport ?? (options.changes ? 'long-poll' : undefined);
    return describeRelay({limits: profile.limits, features, ...(transport ? {transport} : {}), ...(options.serverInfo ? {info: options.serverInfo()} : {})});
}

export type RelayDescriptionInput = {limits: RelayLimits; features: string[]; transport?: LiveTransport; info?: ServerInfo};

/**
 * `GET /v1/server` for any relay, including one that answers it outside this router, such as
 * a Worker in front of Durable Objects. Every relay speaking this protocol has message stages.
 */
export function describeRelay({limits, features, transport, info}: RelayDescriptionInput): ServerDescription {
    return {
        protocol: PROTOCOL_VERSION,
        ...info,
        features: [...new Set(['message-stages', ...features])],
        ...(transport ? {transport: {live: transport, ...(transport === 'long-poll' ? {maxWaitMs: MAX_EVENT_WAIT_MS} : {})}} : {}),
        limits
    };
}

/**
 * A read that waits: registered before reading so a write in between still wakes it, and
 * answered as soon as anything is newer than `after`, at the deadline, or on any other change
 * to the room, so the client rereads whatever else it watches.
 */
async function readWaiting(service: RoomService, changes: ChangeNotifier, roomId: string, credential: string, after: number, limit: number, waitMs: number): Promise<Response> {
    const waiting = changes.wait(roomId, Math.min(waitMs, MAX_EVENT_WAIT_MS));
    try {
        const page = await service.read(roomId, credential, after, limit);
        if (page.events.length > 0 || !waiting || !(await waiting.changed)) {
            return json(page);
        }
        return json(await service.read(roomId, credential, after, limit));
    } finally {
        waiting?.cancel();
    }
}

async function route(request: Request, service: RoomService, admission?: Admission, changes?: ChangeNotifier): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const method = request.method.toUpperCase();

    if (segments[0] !== 'v1') {
        return errorResponse('invalid_request', 'unknown path', 404);
    }

    if (segments[1] === 'rooms' && segments.length === 2 && method === 'POST') {
        await admission?.beforeCreate(request);
        const input = CreateRoomRequest.parse(await request.json());
        const created = await service.createRoom(input);
        return json({room: created.snapshot, participantId: created.participantId, invite: created.invite}, 201);
    }

    if (segments[1] === 'invites' && segments[2] === 'redeem' && method === 'POST') {
        await admission?.beforeRedeem(request);
        const input = RedeemInviteRequest.parse(await request.json());
        try {
            const result = await service.redeemInvite(input);
            return json({roomId: result.roomId, participantId: result.participantId, role: result.role, room: result.snapshot});
        } catch (error) {
            if (error instanceof ProtocolError && error.code === 'invite_unknown') {
                await admission?.afterUnknownInvite(request);
            }
            throw error;
        }
    }

    if (segments[1] !== 'rooms' || segments.length < 3) {
        return errorResponse('invalid_request', 'unknown path', 404);
    }
    const roomId = segments[2]!;

    // Guest entry is the one room route with no credential: knowing the id is the claim.
    if (method === 'POST' && segments[3] === 'guests') {
        const input = JoinAsGuestRequest.parse(await request.json());
        const result = await service.joinAsGuest(roomId, input);
        return json({roomId: result.roomId, participantId: result.participantId, role: result.role, room: result.snapshot});
    }

    const credential = bearer(request);

    if (segments.length === 3 && method === 'GET') {
        return json(await service.snapshot(roomId, credential));
    }
    if (segments.length === 3 && method === 'DELETE') {
        await service.delete(roomId, credential);
        return new Response(null, {status: 204, headers: JSON_HEADERS});
    }

    switch (`${method} ${segments[3]}`) {
        case 'GET turns':
            return json(await service.turns.status(roomId, credential));
        case 'POST turns': {
            const input = await readOptionalJson(request);
            if (segments[4] === 'mode') {
                return json(await service.turns.mode(roomId, credential, TurnModeRequest.parse(input).mode));
            }
            return json(await service.turns.control(roomId, credential, TurnActionRequest.parse(input)));
        }
        case 'POST self': {
            if (segments.length !== 5 || segments[4] !== 'name') {
                return errorResponse('invalid_request', 'unknown self operation', 404);
            }
            return json(await service.renameSelf(roomId, credential, RenameSelfRequest.parse(await request.json())));
        }
        case 'POST rejoin':
            return json(await service.rejoin(roomId, credential));
        case 'POST invites': {
            const {role, reusable, expiresAt, defaultName} = CreateInviteRequest.parse(await readOptionalJson(request));
            return json(await service.mintInvite(roomId, credential, role, reusable, expiresAt, defaultName), 201);
        }
        case 'POST requests': {
            if (segments[4] && segments[5] === 'claim') {
                return json(await service.turns.claim(roomId, credential, segments[4], TurnClaimRequest.parse(await request.json()).claimId));
            }
            if (segments[4] && segments[5] === 'working') {
                await service.turns.working(roomId, credential, segments[4], TurnTokenRequest.parse(await request.json()).token);
                return json({ok: true});
            }
            if (segments[4] && segments[5] === 'renew') {
                return json(await service.turns.renew(roomId, credential, segments[4], TurnTokenRequest.parse(await request.json()).token));
            }
            if (segments[4] && segments[5] === 'pass') {
                await service.turns.pass(roomId, credential, segments[4], TurnTokenRequest.parse(await request.json()).token);
                return json({ok: true});
            }
            if (segments[4] && segments[5] === 'defer') {
                const input = ProviderWaitRequest.parse(await request.json());
                const {token, model, source, ...wait} = input;
                const providerWait: ProviderWait = {...wait, ...(model ? {model} : {}), ...(source ? {source} : {})};
                await service.turns.defer(roomId, credential, segments[4], token, providerWait);
                return json({ok: true});
            }
            if (segments[4] && segments[5] === 'resume') {
                return json(await service.turns.resume(roomId, credential, segments[4]));
            }
            if (segments[4] && segments[5] === 'resolve') {
                return json(await service.resolveRequest(roomId, credential, segments[4], ResolveRequestRequest.parse(await request.json())));
            }
            if (segments[4] && segments[5] === 'ack') {
                return json(await service.acknowledgeMessage(roomId, credential, segments[4]));
            }
            return errorResponse('invalid_request', 'unknown request operation', 404);
        }
        case 'GET requests': {
            if (segments[4]) {
                return json(await service.request(roomId, credential, segments[4]));
            }
            const query = ReadEventsQuery.parse(Object.fromEntries(url.searchParams));
            return json(await service.requests(roomId, credential, query.after, query.limit, url.searchParams.get('to') ?? undefined, url.searchParams.get('turns') === '1'));
        }
        case 'POST files': {
            const name = url.searchParams.get('name') ?? '';
            if (!name.trim() || name.length > 1024) {
                return errorResponse('invalid_request', 'name the file with ?name=', 400);
            }
            const bytes = new Uint8Array(await request.arrayBuffer());
            return json({file: await service.uploadFile(roomId, credential, {name, mediaType: request.headers.get('content-type') ?? '', bytes})}, 201);
        }
        case 'GET files': {
            if (!segments[4]) {
                return json(await service.listFiles(roomId, credential));
            }
            const {file, bytes} = await service.downloadFile(roomId, credential, FileId.parse(segments[4]));
            // Always a download, never something a browser would render or run: the name and type came from another participant.
            return new Response(bytes as Uint8Array<ArrayBuffer>, {status: 200, headers: {'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'content-length': String(bytes.byteLength), 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'pairlobby-file-sha256': file.sha256, [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION)}});
        }
        case 'GET events': {
            const query = ReadEventsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
            if (changes && query.wait > 0) {
                return readWaiting(service, changes, roomId, credential, query.after, query.limit, query.wait);
            }
            return json(await service.read(roomId, credential, query.after, query.limit));
        }
        case 'POST events': {
            const input = SendEventRequest.parse(await request.json());
            const result = await service.send(roomId, credential, input);
            return json(result, result.deduplicated ? 200 : 201);
        }
        case 'POST control': {
            const input = ControlRequest.parse(await request.json());
            if (input.interrupt) {
                if (!input.paused) {
                    return errorResponse('invalid_request', 'an interrupt also pauses; send paused: true', 400);
                }
                const result = await service.interrupt(roomId, credential, input.targetParticipantId);
                return json({revision: result.event.type === 'control.pause' ? result.event.payload.revision : 0, event: result.event, fenced: result.fenced});
            }
            const event = await service.control(roomId, credential, input.targetParticipantId, input.paused);
            return json({revision: event.type === 'control.pause' || event.type === 'control.resume' ? event.payload.revision : 0, event});
        }
        case 'POST name': {
            const {name} = RenameRoomRequest.parse(await request.json());
            return json({event: await service.rename(roomId, credential, name)});
        }
        case 'POST lock': {
            const {locked} = SetLockedRequest.parse(await request.json());
            return json({event: await service.setLocked(roomId, credential, locked)});
        }
        case 'POST participants': {
            if (segments.length === 6 && segments[5] === 'role') {
                const {role} = SetRoleRequest.parse(await request.json());
                return json(await service.setRole(roomId, credential, segments[4]!, role));
            }
            if (segments.length === 6 && segments[5] === 'permissions') {
                const {permissions} = SetPermissionsRequest.parse(await request.json());
                return json(await service.setParticipantPermissions(roomId, credential, segments[4]!, permissions));
            }
            if (segments.length !== 6 || segments[5] !== 'mute') {
                return errorResponse('invalid_request', 'unknown participant operation', 404);
            }
            const {muted} = SetMutedRequest.parse(await request.json());
            return json({event: await service.setMuted(roomId, credential, segments[4]!, muted)});
        }
        case 'POST permissions': {
            const {permissions} = SetPermissionsRequest.parse(await request.json());
            return json(await service.setRoomPermissions(roomId, credential, permissions));
        }
        case 'POST access': {
            const {joinPolicy} = SetAccessRequest.parse(await request.json());
            return json({event: await service.setJoinPolicy(roomId, credential, joinPolicy)});
        }
        case 'POST local-access': {
            const {localJoin} = SetLocalJoinRequest.parse(await request.json());
            return json({event: await service.setLocalJoin(roomId, credential, localJoin)});
        }
        case 'POST auto-close': {
            const {autoClose} = SetAutoCloseRequest.parse(await request.json());
            return json({event: await service.setAutoClose(roomId, credential, autoClose)});
        }
        case 'POST invite-role': {
            const {inviteRole} = SetInviteRoleRequest.parse(await request.json());
            return json({event: await service.setInviteRole(roomId, credential, inviteRole)});
        }
        case 'POST expiry': {
            const {expiresAt} = SetExpiryRequest.parse(await request.json());
            return json({event: await service.setExpiry(roomId, credential, expiresAt)});
        }
        case 'POST close':
            return json({event: await service.close(roomId, credential)});
        case 'POST leave':
            return json({event: await service.leave(roomId, credential)});
        case 'GET export':
            return json(await service.export(roomId, credential));
        case 'DELETE participants': {
            const participantId = segments[4];
            if (!participantId) {
                return errorResponse('invalid_request', 'no participant named', 400);
            }
            return json({event: await service.revoke(roomId, credential, participantId)});
        }
        default:
            return errorResponse('invalid_request', 'unknown path', 404);
    }
}

/** Refuses a request declaring another protocol version, before anything else looks at it. Null when it may go on. */
export function protocolVersionRefusal(request: Request): Response | null {
    const declared = request.headers.get(PROTOCOL_VERSION_HEADER);
    return declared !== null && declared !== String(PROTOCOL_VERSION) ? errorResponse('protocol_version_unsupported', `this server speaks protocol version ${PROTOCOL_VERSION}`, 400) : null;
}

function checkHeaders(request: Request, options: RouterOptions): Response | null {
    const refused = protocolVersionRefusal(request);
    if (refused) {
        return refused;
    }
    const origin = request.headers.get('origin');
    if (origin !== null && !(options.allowedOrigins ?? []).includes(origin)) {
        return errorResponse('unauthorized', 'this origin may not call this server', 401);
    }
    const host = request.headers.get('host');
    const allowedHosts = options.allowedHosts;
    if (allowedHosts && host !== null && !(typeof allowedHosts === 'function' ? allowedHosts(host) : allowedHosts.includes(host))) {
        return errorResponse('unauthorized', 'unexpected host header', 401);
    }
    return null;
}

function bearer(request: Request): string {
    const header = request.headers.get('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) {
        throw new ProtocolError('unauthorized', 'a bearer credential is required');
    }
    return match[1]!;
}

async function readOptionalJson(request: Request): Promise<unknown> {
    const text = await request.text();
    return text.length === 0 ? {} : JSON.parse(text);
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: JSON_HEADERS});
}

function errorResponse(code: ErrorCode, message: string, status: number, details: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({error: {code, message, ...details}}), {status, headers: JSON_HEADERS});
}

function isSchemaError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as {name?: string}).name === 'ZodError';
}

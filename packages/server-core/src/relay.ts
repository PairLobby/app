//! The relay kernel: every protocol rule a relay applies, over Web `Request`/`Response`,
//! so each platform only adapts its transport, storage, ordering and timers (`ports.ts`).
//!
//! A request goes through two halves. `edge` admits it and answers what needs no room;
//! otherwise it names the room. `inRoom` then runs it inside that room. A platform with
//! one process calls `handle`, which does both; one with an object per room, such as a
//! Worker in front of Durable Objects, calls `edge` in front and `inRoom` in the object.

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
    hashCredential,
    newId,
    normalizeInviteCode,
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
import {directExecutor} from './ports.js';
import type {RequestContext, RoomExecutor, Scheduler} from './ports.js';
import type {RoomService} from './service.js';

export interface RelayOptions {
    service: RoomService;
    /** Orders each room's work; defaults to running it as it comes, for a platform that orders it already. */
    executor?: RoomExecutor;
    /** Wakes `tick` for the next auto-close. Absent means the platform runs `tick` itself, such as from a Durable Object alarm. */
    scheduler?: Scheduler;
    /**
     * The room an invite code's digest belongs to, which `edge` needs before any room sees the code.
     * Defaults to the service's own store; a relay with one store per room passes its directory.
     */
    inviteRoom?: (digest: string) => Promise<string | null>;
    /**
     * True when the relay sits behind a proxy or a public address. Every caller then arrives from
     * the proxy, so no connection proves a caller is local, and joining by name is refused.
     */
    behindProxy?: boolean;
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
    peerIsLocal?: (request: Request, context: RequestContext) => boolean;
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

/** Where `edge` sends a request that needs a room: the room's id, and the request to run there. */
export type RoomRoute = {roomId: string; request: Request};

export interface Relay {
    /** Both halves in one process. */
    handle(request: Request, context?: RequestContext): Promise<Response>;
    /** Admission and every route that needs no room. A request reaching `inRoom` must have come through here. */
    edge(request: Request, context?: RequestContext): Promise<Response | RoomRoute>;
    /** A request `edge` sent to `roomId`, run in that room's order. */
    inRoom(request: Request, roomId: string, context?: RequestContext): Promise<Response>;
    /** Closes rooms whose auto-close time has passed, then plans the next wake-up. */
    tick(kind: 'auto-close'): Promise<void>;
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

export function createRelay(options: RelayOptions): Relay {
    const {service} = options;
    const executor = options.executor ?? directExecutor();
    const inviteRoom = options.inviteRoom ?? ((digest: string) => service.inviteRoom(digest));
    const peerIsLocal = (request: Request, context: RequestContext) => !options.behindProxy && Boolean(options.peerIsLocal?.(request, context));

    async function edge(request: Request, context: RequestContext = {}): Promise<Response | RoomRoute> {
        try {
            return await edgeRoute(request, context, options, inviteRoom, peerIsLocal);
        } catch (error) {
            return failure(error);
        }
    }

    async function inRoom(request: Request, roomId: string, context: RequestContext = {}): Promise<Response> {
        const write = !['GET', 'HEAD'].includes(request.method.toUpperCase());
        return executor.run(roomId, write, async () => {
            try {
                return await roomRoute(request, roomId, context, options);
            } catch (error) {
                return failure(error);
            }
        });
    }

    async function tick(_kind: 'auto-close'): Promise<void> {
        const scheduler = options.scheduler;
        await executor.run(null, true, async () => {
            try {
                const result = await service.closeDueRooms();
                scheduler?.plan(result.more ? Date.now() : result.nextAt);
            } catch {
                scheduler?.plan(Date.now() + 60_000);
            }
        });
    }

    return {
        edge,
        inRoom,
        tick,
        async handle(request, context = {}) {
            const routed = await edge(request, context);
            if (routed instanceof Response) {
                return routed;
            }
            const response = inRoom(routed.request, routed.roomId, context);
            // Every write may change an auto-close deadline, so the wake-up is planned again after it.
            if (options.scheduler && !['GET', 'HEAD'].includes(request.method.toUpperCase())) {
                void tick('auto-close');
            }
            return response;
        }
    };
}

function failure(error: unknown): Response {
    if (error instanceof ProtocolError) {
        return errorResponse(error.code, error.message, error.httpStatus, error.details);
    }
    if (isSchemaError(error)) {
        return errorResponse('invalid_request', 'the request body did not match the protocol schema', 400);
    }
    return errorResponse('server_unavailable', 'the server could not complete this request', 503);
}

type InviteRoomLookup = (digest: string) => Promise<string | null>;
type PeerCheck = (request: Request, context: RequestContext) => boolean;

async function edgeRoute(request: Request, context: RequestContext, options: RelayOptions, inviteRoom: InviteRoomLookup, peerIsLocal: PeerCheck): Promise<Response | RoomRoute> {
    const guard = checkHeaders(request, options);
    if (guard) {
        return guard;
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const segments = path.split('/').filter(Boolean);
    const method = request.method.toUpperCase();
    if (method === 'GET' && path === '/v1/server') {
        return json(describe(options));
    }
    if (options.inviteProbe && method === 'GET' && path === '/v1/invites/probe') {
        const prefix = url.searchParams.get('prefix') ?? '';
        if (!new RegExp(`^[0-9a-f]{${INVITE_PROBE_LENGTH}}$`).test(prefix)) {
            return errorResponse('invalid_request', `prefix must be ${INVITE_PROBE_LENGTH} lowercase hex digits`, 400);
        }
        return json({known: await options.inviteProbe(prefix)});
    }
    if (options.discovery && method === 'GET' && path === '/.well-known/pairlobby.json') {
        return new Response(JSON.stringify(options.discovery()), {status: 200, headers: {...JSON_HEADERS, 'cache-control': 'public, max-age=300'}});
    }
    if (options.accountCheck && options.admission && method === 'GET' && path === '/api/online/account') {
        await options.admission.beforeAccountCheck(request, context);
        return json(options.accountCheck(request));
    }
    const local = await routeLocal(request, context, options, peerIsLocal);
    if (local) {
        return local;
    }
    if (segments[0] !== 'v1') {
        return errorResponse('invalid_request', 'unknown path', 404);
    }
    // A new room gets its id here, because a relay with an object per room routes by it.
    if (segments[1] === 'rooms' && segments.length === 2 && method === 'POST') {
        await options.admission?.beforeCreate(request, context);
        return {roomId: newId('room'), request};
    }
    // A code names its room only through its digest; the room then checks the code itself.
    if (segments[1] === 'invites' && segments[2] === 'redeem' && method === 'POST') {
        await options.admission?.beforeRedeem(request, context);
        const body = await request.text();
        const input = RedeemInviteRequest.parse(JSON.parse(body));
        const normalized = normalizeInviteCode(input.code);
        const roomId = normalized ? await inviteRoom(await hashCredential(normalized)) : null;
        if (!roomId) {
            await options.admission?.afterUnknownInvite(request, context);
            throw new ProtocolError('invite_unknown', normalized ? 'that invite code is not valid' : 'that invite code is not well formed');
        }
        return {roomId, request: new Request(request.url, {method: request.method, headers: request.headers, body})};
    }
    if (segments[1] !== 'rooms' || segments.length < 3) {
        return errorResponse('invalid_request', 'unknown path', 404);
    }
    return {roomId: segments[2]!, request};
}

const NOT_LOCAL = 'joining by name is only open to devices on this relay\'s local network or tailnet; ask for an invite code';

/**
 * Finding and joining rooms by name: both need a transport that vouches the caller is local.
 * A lookup is answered here; a join that passes the check goes on to its room.
 */
async function routeLocal(request: Request, context: RequestContext, options: RelayOptions, peerIsLocal: PeerCheck): Promise<Response | RoomRoute | null> {
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
    if (!peerIsLocal(request, context)) {
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
    return {roomId: RoomId.parse(segments[2]), request};
}

/** The relay's own account of itself, from what this router was given: nothing is claimed that it was not. */
export function describe(options: RelayOptions): ServerDescription {
    const profile = options.service.relayProfile();
    const features = [
        ...(profile.files ? ['files'] : []),
        ...(options.peerIsLocal && options.localRooms && !options.behindProxy ? ['local-join'] : []),
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

/** Everything inside one room. Admission already happened in `edge`. */
async function roomRoute(request: Request, roomId: string, context: RequestContext, options: RelayOptions): Promise<Response> {
    const {service, admission, changes} = options;
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const method = request.method.toUpperCase();

    if (segments[1] === 'rooms' && segments.length === 2 && method === 'POST') {
        const input = CreateRoomRequest.parse(await request.json());
        const created = await service.createRoom({...input, roomId});
        return json({room: created.snapshot, participantId: created.participantId, invite: created.invite}, 201);
    }

    if (segments[1] === 'invites' && segments[2] === 'redeem' && method === 'POST') {
        const input = RedeemInviteRequest.parse(await request.json());
        try {
            const result = await service.redeemInvite(input);
            return json({roomId: result.roomId, participantId: result.participantId, role: result.role, room: result.snapshot});
        } catch (error) {
            if (error instanceof ProtocolError && error.code === 'invite_unknown') {
                await admission?.afterUnknownInvite(request, context);
            }
            throw error;
        }
    }

    if (method === 'POST' && segments.length === 4 && segments[3] === 'local-join') {
        const input = LocalJoinRequest.parse(await request.json());
        const result = await service.joinOnLocalNetwork(roomId, input);
        return json({roomId: result.roomId, participantId: result.participantId, role: result.role, room: result.snapshot});
    }

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

function checkHeaders(request: Request, options: RelayOptions): Response | null {
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

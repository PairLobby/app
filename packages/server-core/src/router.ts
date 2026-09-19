//! Transport-agnostic routing over Web `Request`/`Response`, so the Node server
//! and the Cloudflare Worker share one implementation of the HTTP contract.

import {
    CreateInviteRequest,
    CreateRoomRequest,
    PROTOCOL_VERSION,
    PROTOCOL_VERSION_HEADER,
    ProtocolError,
    ReadEventsQuery,
    RedeemInviteRequest,
    JoinAsGuestRequest,
    RenameRoomRequest,
    SendEventRequest,
    SetAccessRequest,
    SetExpiryRequest,
    ControlRequest
} from '@pairlobby/protocol';
import type {ErrorCode} from '@pairlobby/protocol';

import type {RoomService} from './service.js';

export interface RouterOptions {
    service: RoomService;
    /**
     * Exact origins a browser may call from. A CLI sends no `Origin`, so an
     * unexpected one means a web page is talking to us — including a malicious
     * page reaching for loopback.
     */
    allowedOrigins?: string[];
    /** Exact `Host` values to accept, defeating DNS rebinding against a local server. */
    allowedHosts?: string[];
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
            return await route(request, service);
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

async function route(request: Request, service: RoomService): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const method = request.method.toUpperCase();

    if (segments[0] !== 'v1') {
        return errorResponse('invalid_request', 'unknown path', 404);
    }

    if (segments[1] === 'rooms' && segments.length === 2 && method === 'POST') {
        const input = CreateRoomRequest.parse(await request.json());
        const created = await service.createRoom(input);
        return json({room: created.snapshot, participantId: created.participantId, invite: created.invite}, 201);
    }

    if (segments[1] === 'invites' && segments[2] === 'redeem' && method === 'POST') {
        const input = RedeemInviteRequest.parse(await request.json());
        const result = await service.redeemInvite(input);
        return json({roomId: result.roomId, participantId: result.participantId, role: result.role, room: result.snapshot});
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
        case 'POST invites': {
            const {role, reusable, expiresAt} = CreateInviteRequest.parse(await readOptionalJson(request));
            return json(await service.mintInvite(roomId, credential, role, reusable, expiresAt), 201);
        }
        case 'POST requests': {
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
            return json(await service.requests(roomId, credential, query.after, query.limit, url.searchParams.get('to') ?? undefined));
        }
        case 'GET events': {
            const query = ReadEventsQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
            return json(await service.read(roomId, credential, query.after, query.limit));
        }
        case 'POST events': {
            const input = SendEventRequest.parse(await request.json());
            const result = await service.send(roomId, credential, input);
            return json(result, result.deduplicated ? 200 : 201);
        }
        case 'POST control': {
            const input = ControlRequest.parse(await request.json());
            const event = await service.control(roomId, credential, input.targetParticipantId, input.paused);
            return json({revision: event.type === 'control.pause' || event.type === 'control.resume' ? event.payload.revision : 0, event});
        }
        case 'POST name': {
            const {name} = RenameRoomRequest.parse(await request.json());
            return json({event: await service.rename(roomId, credential, name)});
        }
        case 'POST access': {
            const {joinPolicy} = SetAccessRequest.parse(await request.json());
            return json({event: await service.setJoinPolicy(roomId, credential, joinPolicy)});
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

function checkHeaders(request: Request, options: RouterOptions): Response | null {
    const declared = request.headers.get(PROTOCOL_VERSION_HEADER);
    if (declared !== null && declared !== String(PROTOCOL_VERSION)) {
        return errorResponse('protocol_version_unsupported', `this server speaks protocol version ${PROTOCOL_VERSION}`, 400);
    }
    const origin = request.headers.get('origin');
    if (origin !== null && !(options.allowedOrigins ?? []).includes(origin)) {
        return errorResponse('unauthorized', 'this origin may not call this server', 401);
    }
    const host = request.headers.get('host');
    if (options.allowedHosts && host !== null && !options.allowedHosts.includes(host)) {
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

//! The HTTP client shared by the CLI and the MCP bridge. It turns protocol error
//! bodies back into `ProtocolError`, so callers handle one error type whether a
//! failure came from local validation or from the server.

import {PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, ProtocolError, ServerFrame, newCredential, newId} from '@pairlobby/protocol';
import type {
    AdapterCapabilities,
    MessageRequest,
    RequestPage,
    CreateInviteResponse,
    ErrorCode,
    ExportResponse,
    ParticipantKind,
    ParticipantRole,
    ReadEventsResponse,
    RoomEvent,
    RoomSnapshot,
    SendEventRequest,
    SendEventResponse
} from '@pairlobby/protocol';

type RoomAccountAccess = {private: boolean; allowedAccounts: string[]};

type InviteAttempt = {attemptId: string; participantCredential: string};

type OperationResult = {ok: boolean};

type HandoverRevisionResult = {revision: number; event: RoomEvent};

type RoomEventResult = {event: RoomEvent};

export interface ClientIdentity {
    displayName: string;
    kind: ParticipantKind;
    sessionId?: string;
    capabilities?: AdapterCapabilities;
}

export interface CreatedRoom {
    roomId: string;
    participantId: string;
    controllerCredential: string;
    participantCredential: string;
    invite: {code: string; expiresAt: number};
    room: RoomSnapshot;
}

export interface JoinedRoom {
    roomId: string;
    participantId: string;
    participantCredential: string;
    role: ParticipantRole;
    room: RoomSnapshot;
}

export class PairLobbyClient {
    readonly serverUrl: string;

    private socket: WebSocket | null = null;
    private watermark = 0;
    private earliestSeq = 0;
    private liveEvents: RoomEvent[] = [];
    private liveBytes = 0;
    private liveRoom: string | null = null;
    private changed = new Set<() => void>();

    constructor(serverUrl: string, private readonly accountToken?: string
    ) {
        this.serverUrl = serverUrl.replace(/\/+$/, '');
    }

    async createRoom(name: string, identity: ClientIdentity, expiresAt?: number | null, access?: RoomAccountAccess): Promise<CreatedRoom> {
        // Both credentials are generated here, so a lost response never strands a secret the caller does not hold.
        const controllerCredential = newCredential('controller');
        const participantCredential = newCredential('participant');
        const body = await this.call<{room: RoomSnapshot; participantId: string; invite: {code: string; expiresAt: number}}>('POST', '/v1/rooms', null, {
            name,
            controllerCredential,
            participantCredential,
            ...identity,
            ...(expiresAt !== undefined ? {expiresAt} : {}),
            ...access
        });
        return {roomId: body.room.roomId, participantId: body.participantId, controllerCredential, participantCredential, invite: body.invite, room: body.room};
    }

    /** `attemptId` and the credential must be reused across retries, or a crashed join forks a second membership. */
    async redeemInvite(code: string, identity: ClientIdentity, attempt?: InviteAttempt): Promise<JoinedRoom> {
        const attemptId = attempt?.attemptId ?? newId('attempt');
        const participantCredential = attempt?.participantCredential ?? newCredential('participant');
        const body = await this.call<{roomId: string; participantId: string; role: ParticipantRole; room: RoomSnapshot}>('POST', '/v1/invites/redeem', null, {
            code,
            attemptId,
            attemptSecret: newCredential('attempt'),
            participantCredential,
            ...identity
        });
        return {roomId: body.roomId, participantId: body.participantId, participantCredential, role: body.role, room: body.room};
    }

    snapshot(roomId: string, credential: string): Promise<RoomSnapshot> {
        return this.call('GET', `/v1/rooms/${roomId}`, credential);
    }

    mintInvite(roomId: string, credential: string, role: ParticipantRole = 'member', reusable = true, expiresAt?: number | null): Promise<CreateInviteResponse> {
        return this.call('POST', `/v1/rooms/${roomId}/invites`, credential, {role, reusable, ...(expiresAt !== undefined ? {expiresAt} : {})});
    }

    setAllowedAccounts(roomId: string, credential: string, accounts: string[]): Promise<OperationResult> {
        return this.call('PUT', `/v1/rooms/${roomId}/allowed-accounts`, credential, {private: true, accounts});
    }

    readEvents(roomId: string, credential: string, after: number, limit = 200): Promise<ReadEventsResponse> {
        if (this.liveRoom === roomId && this.socket?.readyState === WebSocket.OPEN) {
            const events = this.liveEvents.filter((event) => event.seq > after).slice(0, limit);
            if (events[0]?.seq === after + 1 || after === this.watermark) {
                return Promise.resolve({events, earliestSeq: this.earliestSeq, latestSeq: this.watermark, hasMore: (events.at(-1)?.seq ?? after) < this.watermark});
            }
        }
        return this.call('GET', `/v1/rooms/${roomId}/events?after=${after}&limit=${limit}`, credential);
    }

    requests(roomId: string, credential: string, after = 0, limit = 100, recipientId?: string): Promise<RequestPage> {
        return this.call('GET', `/v1/rooms/${roomId}/requests?after=${after}&limit=${limit}${recipientId ? `&to=${encodeURIComponent(recipientId)}` : ''}`, credential);
    }
    async pendingRequests(roomId: string, credential: string, recipientId?: string): Promise<MessageRequest[]> {
        const requests: MessageRequest[] = [];
        let after = 0;
        for (let pageNumber = 0; pageNumber < 11; pageNumber++) {
            const page = await this.requests(roomId, credential, after, 100, recipientId);
            requests.push(...page.requests);
            if (!page.hasMore) {
                return requests;
            }
            const next = page.requests.at(-1)?.seq;
            if (next === undefined || next <= after) {
                throw new ProtocolError('server_unavailable', 'request pagination did not advance');
            }
            after = next;
        }
        throw new ProtocolError('server_unavailable', 'pending request limit exceeded; inbox cannot be verified');
    }
    request(roomId: string, credential: string, eventId: string): Promise<MessageRequest> {
        return this.call('GET', `/v1/rooms/${roomId}/requests/${eventId}`, credential);
    }
    async acknowledgeMessage(roomId: string, credential: string, eventId: string): Promise<void> {
        await this.call('POST', `/v1/rooms/${roomId}/requests/${eventId}/ack`, credential, {});
    }
    async deliveryFailed(roomId: string, credential: string, eventId: string, reason: string): Promise<void> {
        const request = await this.request(roomId, credential, eventId);
        if (request.failureAt || request.responseEventId) {
            return;
        }
        await this.send(roomId, credential, {type: 'message.delivery_failed', payload: {eventId, reason}, idempotencyKey: `failure-${eventId}`});
    }
    async reply(roomId: string, credential: string, eventId: string, text: string, progress = false): Promise<SendEventResponse> {
        const target = await this.request(roomId, credential, eventId);
        if (target.receivedAt === null) {
            await this.acknowledgeMessage(roomId, credential, eventId);
        }
        return this.send(roomId, credential, {
            type: 'message',
            recipientId: target.from,
            replyTo: eventId,
            payload: {text, priority: 'normal', responseStage: progress ? 'progress' : 'final'},
            idempotencyKey: progress ? newId('event') : `reply-${eventId}`
        });
    }

    send(roomId: string, credential: string, request: SendEventRequest): Promise<SendEventResponse> {
        return this.call('POST', `/v1/rooms/${roomId}/events`, credential, request);
    }

    control(roomId: string, credential: string, targetParticipantId: string, paused: boolean): Promise<HandoverRevisionResult> {
        return this.call('POST', `/v1/rooms/${roomId}/control`, credential, {targetParticipantId, paused});
    }

    revoke(roomId: string, credential: string, participantId: string): Promise<RoomEventResult> {
        return this.call('DELETE', `/v1/rooms/${roomId}/participants/${participantId}`, credential);
    }

    leave(roomId: string, credential: string): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/leave`, credential, {});
    }

    rename(roomId: string, credential: string, name: string): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/name`, credential, {name});
    }

    setJoinPolicy(roomId: string, credential: string, joinPolicy: 'invite_only' | 'open_to_guests'): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/access`, credential, {joinPolicy});
    }

    /** Enters an open room as a read-only guest. No invite code, no credential to present. */
    async joinAsGuest(roomId: string, identity: ClientIdentity): Promise<JoinedRoom> {
        const participantCredential = newCredential('participant');
        const body = await this.call<{roomId: string; participantId: string; role: ParticipantRole; room: RoomSnapshot}>('POST', `/v1/rooms/${roomId}/guests`, null, {
            participantCredential,
            ...identity
        });
        return {roomId: body.roomId, participantId: body.participantId, participantCredential, role: body.role, room: body.room};
    }

    setExpiry(roomId: string, credential: string, expiresAt: number | null): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/expiry`, credential, {expiresAt});
    }

    close(roomId: string, credential: string): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/close`, credential, {});
    }

    export(roomId: string, credential: string): Promise<ExportResponse> {
        return this.call('GET', `/v1/rooms/${roomId}/export`, credential);
    }

    async delete(roomId: string, credential: string): Promise<void> {
        await this.call('DELETE', `/v1/rooms/${roomId}`, credential);
    }

    /** Hosted reads sleep on socket notifications; local relays retain polling. */
    async waitForChange(roomId: string, credential: string, after: number, timeoutMs: number, localIntervalMs = 1000): Promise<void> {
        if (!new URL(this.serverUrl).pathname.startsWith('/relay/')) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, localIntervalMs)));
            return;
        }
        if (this.liveRoom !== roomId) {
            this.closeLive();
        }
        if (!this.socket) {
            const {ticket} = await this.call<{ticket: string}>('POST', `/v1/rooms/${roomId}/connect-ticket`, credential, {});
            const url = new URL(`${this.serverUrl}/v1/rooms/${roomId}/connect`);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            url.searchParams.set('ticket', ticket);
            const socket = new WebSocket(url);
            this.socket = socket;
            this.liveRoom = roomId;
            this.watermark = after;
            socket.addEventListener('message', (event) => {
                try {
                    const frame = ServerFrame.parse(JSON.parse(String(event.data)));
                    if (frame.type === 'hello') {
                        this.watermark = Math.max(this.watermark, frame.watermarkSeq);
                        this.earliestSeq = frame.snapshot.earliestSeq;
                    }
                    if (frame.type === 'event') {
                        this.watermark = Math.max(this.watermark, frame.event.seq);
                        this.liveEvents.push(frame.event);
                        this.liveBytes += new TextEncoder().encode(JSON.stringify(frame.event)).byteLength;
                        while (this.liveEvents.length > 500 || this.liveBytes > 1024 * 1024)
                            this.liveBytes -= new TextEncoder().encode(JSON.stringify(this.liveEvents.shift())).byteLength;
                    }
                    if (frame.type === 'error' && frame.fatal) {
                        socket.close();
                        return;
                    }
                    for (const wake of this.changed) wake();
                } catch {
                    socket.close();
                }
            });
            const closed = () => {
                if (this.socket === socket) {
                    this.socket = null;
                }
                for (const wake of this.changed) wake();
            };
            socket.addEventListener('close', closed);
            socket.addEventListener('error', closed);
        }
        if (this.watermark > after) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const finish = () => {
                if (this.watermark <= after && this.socket) {
                    return;
                }
                clearTimeout(timer);
                this.changed.delete(finish);
                if (!this.socket) {
                    reject(new ProtocolError('server_unavailable', 'Live connection closed; reconnect to resume'));
                } else {
                    resolve();
                }
            };
            const timer = setTimeout(() => {
                this.changed.delete(finish);
                resolve();
            }, timeoutMs);
            this.changed.add(finish);
            finish();
        });
    }

    closeLive(): void {
        const socket = this.socket;
        this.socket = null;
        this.liveRoom = null;
        this.watermark = 0;
        this.liveEvents = [];
        this.liveBytes = 0;
        socket?.close();
        for (const wake of this.changed) wake();
    }

    private async call<T>(method: string, path: string, credential: string | null, body?: unknown): Promise<T> {
        const headers = new Headers({[PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION)});
        if (credential) {
            headers.set('authorization', `Bearer ${credential}`);
        }
        if (this.accountToken && method === 'POST' && (path === '/v1/rooms' || path === '/v1/invites/redeem')) {
            headers.set('x-pairlobby-account-token', this.accountToken);
        }
        if (body !== undefined) {
            headers.set('content-type', 'application/json');
        }

        let response: Response;
        try {
            response = await fetch(`${this.serverUrl}${path}`, {
                method,
                headers,
                redirect: 'error',
                signal: AbortSignal.timeout(path.endsWith('/export') ? 60_000 : 15_000),
                ...(body === undefined ? {} : {body: JSON.stringify(body)})
            });
        } catch {
            throw new ProtocolError('server_unavailable', `could not reach ${this.serverUrl}`, {retryAfterMs: 1000});
        }
        if (response.status === 204) {
            return undefined as T;
        }
        const text = await response.text();
        if (!response.ok) {
            throw toProtocolError(response.status, text);
        }
        return JSON.parse(text) as T;
    }
}

function toProtocolError(status: number, text: string): ProtocolError {
    try {
        const parsed = JSON.parse(text) as {error?: {code?: ErrorCode; message?: string; retryAfterMs?: number; earliestAvailableSeq?: number; currentRevision?: number}};
        if (parsed.error?.code) {
            const {code, message, ...details} = parsed.error;
            return new ProtocolError(code, message ?? 'the server refused this request', details);
        }
    } catch {
        // Fall through to a generic error rather than surfacing a parse failure.
    }
    return new ProtocolError(status >= 500 ? 'server_unavailable' : 'invalid_request', `the server returned ${status}`);
}

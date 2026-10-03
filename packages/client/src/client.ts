//! The HTTP client shared by the CLI and the MCP bridge. It turns protocol error
//! bodies back into `ProtocolError`, so callers handle one error type whether a
//! failure came from local validation or from the server.

import {PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, ProtocolError, ServerFrame, newCredential, newId} from '@pairlobby/protocol';
import type {
    AdapterCapabilities,
    AutoClosePolicy,
    MessageRequest,
    MessageAction,
    TurnAction,
    TurnGrant,
    TurnMode,
    TurnQueue,
    RequestPage,
    CreateInviteResponse,
    ErrorCode,
    ExportResponse,
    ParticipantKind,
    NameSource,
    ParticipantRole,
    ReadEventsResponse,
    RoomEvent,
    RoomSnapshot,
    SendEventRequest,
    SendEventResponse
} from '@pairlobby/protocol';

type RoomAccountAccess = {private: boolean; allowedAccounts: string[]};
export type RoomAccountRestrictions = {private: boolean; accounts: string[]; preserveAllowlistSupported?: boolean};

type InviteAttempt = {attemptId: string; participantCredential: string};

type OperationResult = {ok: boolean};
export type MessageStatusOptions = {reason?: string; turnToken?: string; responseEventId?: string};

type HandoverRevisionResult = {revision: number; event: RoomEvent};

export type InterruptResult = {revision: number; event: RoomEvent; fenced: string[]};

type RoomEventResult = {event: RoomEvent};

export interface ClientIdentity {
    displayName: string;
    nameSource?: NameSource;
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

export type ServerShareInfo = {
    /** Addresses other devices can join through; empty when the server only listens on the device running it. */
    shareUrls: string[];
};

export class PairLobbyClient {
    readonly serverUrl: string;

    private socket: WebSocket | null = null;
    private watermark = 0;
    private earliestSeq = 0;
    private liveEvents: RoomEvent[] = [];
    private liveBytes = 0;
    private liveRoom: string | null = null;
    private changed = new Set<() => void>();

    constructor(serverUrl: string, private readonly accountToken?: string, private readonly signal?: AbortSignal) {
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
    async redeemInvite(code: string, identity: ClientIdentity, attempt?: InviteAttempt, useInviteName = true): Promise<JoinedRoom> {
        const attemptId = attempt?.attemptId ?? newId('attempt');
        const participantCredential = attempt?.participantCredential ?? newCredential('participant');
        const body = await this.call<{roomId: string; participantId: string; role: ParticipantRole; room: RoomSnapshot}>('POST', '/v1/invites/redeem', null, {
            code,
            useInviteName,
            attemptId,
            attemptSecret: newCredential('attempt'),
            participantCredential,
            ...identity
        });
        return {roomId: body.roomId, participantId: body.participantId, participantCredential, role: body.role, room: body.room};
    }

    /** Older servers and hosted relays do not answer this, which means they have nothing extra to share. */
    async serverInfo(): Promise<ServerShareInfo> {
        try {
            const info = await this.call<Partial<ServerShareInfo>>('GET', '/v1/server', null);
            return {shareUrls: Array.isArray(info.shareUrls) ? info.shareUrls.filter((url) => typeof url === 'string') : []};
        } catch (error) {
            if (error instanceof ProtocolError && error.code === 'invalid_request') {
                return {shareUrls: []};
            }
            throw error;
        }
    }

    /** Joins a room this client's account is allowed into; needs the account token and a server with account login. */
    async joinWithAccount(roomId: string, identity: ClientIdentity, attempt?: InviteAttempt): Promise<JoinedRoom> {
        const attemptId = attempt?.attemptId ?? newId('attempt');
        const participantCredential = attempt?.participantCredential ?? newCredential('participant');
        const body = await this.call<{roomId: string; participantId: string; role: ParticipantRole; room: RoomSnapshot}>('POST', `/v1/rooms/${roomId}/account-join`, null, {
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

    mintInvite(roomId: string, credential: string, role: ParticipantRole = 'member', reusable = true, expiresAt?: number | null, defaultName?: string): Promise<CreateInviteResponse> {
        return this.call('POST', `/v1/rooms/${roomId}/invites`, credential, {role, reusable, ...(expiresAt !== undefined ? {expiresAt} : {}), ...(defaultName !== undefined ? {defaultName} : {})});
    }

    setLocked(roomId: string, credential: string, locked: boolean): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/lock`, credential, {locked});
    }

    setMuted(roomId: string, credential: string, participantId: string, muted: boolean): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/participants/${participantId}/mute`, credential, {muted});
    }

    setRole(roomId: string, credential: string, participantId: string, role: 'member' | 'controller'): Promise<RoomSnapshot> {
        return this.call('POST', `/v1/rooms/${roomId}/participants/${participantId}/role`, credential, {role});
    }

    accountRestrictions(roomId: string, credential: string): Promise<RoomAccountRestrictions> {
        return this.call('GET', `/v1/rooms/${roomId}/allowed-accounts`, credential);
    }

    setAccountRestrictions(roomId: string, credential: string, privateRoom: boolean, emails?: string[]): Promise<OperationResult> {
        return this.call('PUT', `/v1/rooms/${roomId}/allowed-accounts`, credential, {private: privateRoom, ...(emails ? {accounts: emails} : {})});
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
        return this.call('GET', `/v1/rooms/${roomId}/requests?turns=1&after=${after}&limit=${limit}${recipientId ? `&to=${encodeURIComponent(recipientId)}` : ''}`, credential);
    }
    turnQueue(roomId: string, credential: string): Promise<TurnQueue> {
        return this.call('GET', `/v1/rooms/${roomId}/turns`, credential);
    }
    setTurnMode(roomId: string, credential: string, mode: TurnMode): Promise<TurnQueue> {
        return this.call('POST', `/v1/rooms/${roomId}/turns/mode`, credential, {mode});
    }
    controlTurn(roomId: string, credential: string, action: TurnAction): Promise<TurnQueue> {
        return this.call('POST', `/v1/rooms/${roomId}/turns`, credential, action);
    }
    claimTurn(roomId: string, credential: string, requestId: string, claimId: string): Promise<TurnGrant> {
        return this.call('POST', `/v1/rooms/${roomId}/requests/${requestId}/claim`, credential, {claimId});
    }
    renewTurn(roomId: string, credential: string, requestId: string, token: string): Promise<TurnGrant> {
        return this.call('POST', `/v1/rooms/${roomId}/requests/${requestId}/renew`, credential, {token});
    }
    async declareWorking(roomId: string, credential: string, requestId: string, token: string): Promise<void> {
        await this.call('POST', `/v1/rooms/${roomId}/requests/${requestId}/working`, credential, {token});
    }
    async passTurn(roomId: string, credential: string, requestId: string, token: string): Promise<void> {
        await this.call('POST', `/v1/rooms/${roomId}/requests/${requestId}/pass`, credential, {token});
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
    async reportMessageStatus(roomId: string, credential: string, eventId: string, action: MessageAction | 'read', options: MessageStatusOptions = {}): Promise<void> {
        if (!(await this.snapshot(roomId, credential)).messageStagesSupported) {
            throw new ProtocolError('unsupported_capability', 'Update this relay before declaring Read or message action stages.');
        }
        await this.send(roomId, credential, {type: 'message.received', payload: {eventId, ...(action !== 'reply_pending' ? {stage: 'read' as const} : {}), ...(action !== 'read' ? {action} : {}), ...(options.reason ? {reason: options.reason} : {}), ...(options.responseEventId ? {responseEventId: options.responseEventId} : {})}, idempotencyKey: action === 'done' && options.responseEventId ? `link-${eventId}-${options.responseEventId}` : newId('event'), ...(options.turnToken ? {turnToken: options.turnToken} : {})});
    }
    async deliveryFailed(roomId: string, credential: string, eventId: string, reason: string, turnToken?: string, stage?: MessageRequest['failureStage']): Promise<void> {
        const request = await this.request(roomId, credential, eventId);
        if (request.failureAt || request.responseEventId) {
            return;
        }
        await this.send(roomId, credential, {type: 'message.delivery_failed', payload: {eventId: request.eventId, reason, ...(stage ? {stage} : {})}, idempotencyKey: `failure-${request.eventId}`, ...(turnToken ? {turnToken} : {})});
    }
    async reply(roomId: string, credential: string, eventId: string, text: string, progress = false, turnToken?: string): Promise<SendEventResponse> {
        const target = await this.request(roomId, credential, eventId);
        if (target.receivedAt === null) {
            await this.acknowledgeMessage(roomId, credential, eventId);
        }
        return this.send(roomId, credential, {
            type: 'message',
            recipientId: target.from,
            replyTo: target.eventId,
            ...(turnToken ? {turnToken} : {}),
            payload: {text, priority: 'normal', responseStage: progress ? 'progress' : 'final'},
            idempotencyKey: progress ? newId('event') : `reply-${target.eventId}`
        });
    }

    send(roomId: string, credential: string, request: SendEventRequest): Promise<SendEventResponse> {
        return this.call('POST', `/v1/rooms/${roomId}/events`, credential, request);
    }

    control(roomId: string, credential: string, targetParticipantId: string, paused: boolean): Promise<HandoverRevisionResult> {
        return this.call('POST', `/v1/rooms/${roomId}/control`, credential, {targetParticipantId, paused});
    }

    /** Stops one agent's running turn and holds its queued work until resume. Owner or admin only. */
    interrupt(roomId: string, credential: string, targetParticipantId: string): Promise<InterruptResult> {
        return this.call('POST', `/v1/rooms/${roomId}/control`, credential, {targetParticipantId, paused: true, interrupt: true});
    }

    revoke(roomId: string, credential: string, participantId: string): Promise<RoomEventResult> {
        return this.call('DELETE', `/v1/rooms/${roomId}/participants/${participantId}`, credential);
    }

    leave(roomId: string, credential: string): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/leave`, credential, {});
    }

    rejoin(roomId: string, credential: string): Promise<RoomSnapshot> {
        return this.call('POST', `/v1/rooms/${roomId}/rejoin`, credential, {});
    }

    renameSelf(roomId: string, credential: string, name: string, source: NameSource = 'room'): Promise<RoomSnapshot> {
        return this.call('POST', `/v1/rooms/${roomId}/self/name`, credential, {name, source});
    }

    rename(roomId: string, credential: string, name: string): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/name`, credential, {name});
    }

    setAutoClose(roomId: string, credential: string, autoClose: AutoClosePolicy): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/auto-close`, credential, {autoClose});
    }

    setInviteRole(roomId: string, credential: string, inviteRole: 'member' | 'guest'): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/invite-role`, credential, {inviteRole});
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
                let raw: unknown;
                try {
                    raw = JSON.parse(String(event.data));
                    const frame = ServerFrame.parse(raw);
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
                    // An event kind from a newer relay is not a broken connection: skip it,
                    // and the gap it leaves makes the next read fetch it over HTTP instead.
                    if (isEventFrame(raw)) {
                        for (const wake of this.changed) wake();
                        return;
                    }
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
        if (this.accountToken && method === 'POST' && (path === '/v1/rooms' || path === '/v1/invites/redeem' || path.endsWith('/account-join'))) {
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
                signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(path.endsWith('/export') ? 60_000 : 15_000)]) : AbortSignal.timeout(path.endsWith('/export') ? 60_000 : 15_000),
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

function isEventFrame(value: unknown): boolean {
    const frame = value as {type?: unknown; event?: {seq?: unknown}} | null;
    return typeof frame === 'object' && frame !== null && frame.type === 'event' && typeof frame.event?.seq === 'number';
}

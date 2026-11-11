//! The HTTP client shared by the CLI and the MCP bridge. It turns protocol error
//! bodies back into `ProtocolError`, so callers handle one error type whether a
//! failure came from local validation or from the server.

import {sha256} from '@noble/hashes/sha2.js';
import {ABSOLUTE_MAX_FILE_BYTES, ExportStreamRecord, FILE_SIZE_HEADER, MAX_EVENT_WAIT_MS, PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, ProtocolError, ServerDescription, ServerFrame, newCredential, newId} from '@pairlobby/protocol';
import type {
    AdapterCapabilities,
    Attachment,
    AutoClosePolicy,
    MessageRequest,
    ProviderWait,
    MessageAction,
    TurnAction,
    TurnGrant,
    TurnMode,
    TurnQueue,
    RequestPage,
    CreateInviteResponse,
    ErrorCode,
    ExportResponse,
    ListFilesResponse,
    LocalRoom,
    ParticipantKind,
    NameSource,
    ParticipantRole,
    PermissionChange,
    ListingPresenceRequest,
    ListingResponse,
    DirectoryResponse,
    ContactResponse,
    ListingView,
    LiveTransport,
    ReadEventsResponse,
    ReceiptResponse,
    RoomEvent,
    RoomFile,
    RoomSnapshot,
    RoomType,
    RoomVisibility,
    DefaultVisibility,
    SendEventRequest,
    SendEventResponse,
    ShareListingRequest
} from '@pairlobby/protocol';

type RawUpload = {body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>; contentType: string; size: number};
type StreamingRequestInit = RequestInit & {duplex?: 'half'};
export type StreamUpload = {name: string; body: ReadableStream<Uint8Array>; size: number; mediaType?: string};
type RoomAccountAccess = {private: boolean; allowedAccounts: string[]};
export type RoomAccountRestrictions = {private: boolean; accounts: string[]; preserveAllowlistSupported?: boolean};

type InviteAttempt = {attemptId: string; participantCredential: string};

type OperationResult = {ok: boolean};
export type MessageStatusOptions = {reason?: string; turnToken?: string; responseEventId?: string};
export type ReadEventsOptions = {receiptsAfter?: number};
export type SyncEventsOptions = {after: number; limit?: number; waitMs?: number; stateAfter: number; snapshotAfter?: number; receiptsAfter?: number; signal?: AbortSignal};
export type LiveWaitOptions = {stateAfter?: number};
export type DirectoryReadOptions = {owner?: string; after?: string; limit?: number};

type HandoverRevisionResult = {revision: number; event: RoomEvent};

export type InterruptResult = {revision: number; event: RoomEvent; fenced: string[]};
export type RequestResolutionResult = {event: RoomEvent; request: MessageRequest; deduplicated: boolean};

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
    invite: {code: string; expiresAt: number | null};
    room: RoomSnapshot;
}

export interface JoinedRoom {
    roomId: string;
    participantId: string;
    participantCredential: string;
    role: ParticipantRole;
    room: RoomSnapshot;
}

/** An invitation to a hosted room, as its owner and admins see it. `guest` is a read-only visitor. */
export type RoomInvitation = {id: string; handle: string; role: 'member' | 'guest'; agents: number; state: 'pending' | 'accepted'; createdAt: number; expiresAt: number};

/** A relay's answer to an invite probe: it issued a matching code, it did not, it predates probes, or it could not be asked. */
export type InviteProbeResult = 'known' | 'unknown' | 'unsupported' | 'unreachable';

export type ServerShareInfo = {
    /** Addresses other devices can join through; empty when the server only listens on the device running it. */
    shareUrls: string[];
    /** False when the server does not answer at all: a hosted or durable relay rather than `pairlobby serve`. */
    reported: boolean;
    /** True when a device on the same network or tailnet can find this server from an invite code alone. */
    discoverable: boolean;
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
    private description: Promise<ServerDescription | null> | null = null;
    private liveRevision = 0;
    private connecting: Promise<void> | null = null;
    private readonly connectionId = newId('event');
    /** Cancels a held read or a poll sleep in progress, so `closeLive` wakes every kind of wait. */
    private liveWait = new AbortController();

    constructor(serverUrl: string, private readonly accountToken?: string, private readonly signal?: AbortSignal) {
        this.serverUrl = serverUrl.replace(/\/+$/, '');
    }

    async createRoom(name: string, identity: ClientIdentity, expiresAt?: number | null, access?: RoomAccountAccess, type?: RoomType, visibility?: RoomVisibility): Promise<CreatedRoom> {
        // Both credentials are generated here, so a lost response never strands a secret the caller does not hold.
        const controllerCredential = newCredential('controller');
        const participantCredential = newCredential('participant');
        const body = await this.call<{room: RoomSnapshot; participantId: string; invite: CreatedRoom['invite']}>('POST', '/v1/rooms', null, {
            name,
            controllerCredential,
            participantCredential,
            ...identity,
            ...(expiresAt !== undefined ? {expiresAt} : {}),
            ...access,
            ...(type ? {type} : {}),
            ...(visibility ? {visibility} : {})
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

    /**
     * Asks whether this server issued an invite whose digest starts with `probe`
     * (see `inviteProbe`), without sending the code. Never throws: a device looking
     * for the right relay asks several, and most will not be it.
     */
    async probeInvite(probe: string, timeoutMs = 1500): Promise<InviteProbeResult> {
        let response: Response;
        try {
            response = await fetch(`${this.serverUrl}/v1/invites/probe?prefix=${encodeURIComponent(probe)}`, {headers: {[PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION)}, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
        } catch {
            return 'unreachable';
        }
        if (response.status === 404) {
            return 'unsupported';
        }
        if (!response.ok) {
            return 'unreachable';
        }
        try {
            return ((await response.json()) as {known?: unknown}).known === true ? 'known' : 'unknown';
        } catch {
            return 'unreachable';
        }
    }

    /** Only `pairlobby serve` reports share addresses; other relays describe themselves without them, and older ones not at all. */
    async serverInfo(): Promise<ServerShareInfo> {
        const info = await this.describe(true);
        const shareUrls = info?.shareUrls;
        return {shareUrls: shareUrls ? shareUrls.filter((url) => typeof url === 'string') : [], reported: shareUrls !== undefined, discoverable: info?.discoverable === true};
    }

    /**
     * What the relay says about itself (`GET /v1/server`), asked once per client. Null for a relay
     * that does not describe itself. `strict` lets a connection failure through instead of
     * remembering it as "no description", for callers that report reachability.
     */
    async describe(strict = false): Promise<ServerDescription | null> {
        this.description ??= this.call<unknown>('GET', '/v1/server', null).then((raw) => {
            const parsed = ServerDescription.safeParse(raw);
            return parsed.success ? parsed.data : null;
        }, (error: unknown) => {
            if (error instanceof ProtocolError && error.code === 'invalid_request') {
                return null;
            }
            this.description = null;
            throw error;
        });
        try {
            return await this.description;
        } catch (error) {
            if (strict) {
                throw error;
            }
            return null;
        }
    }

    /**
     * How this client hears about new events: what the relay describes, or for a relay that does
     * not say, a socket on hosted rooms (under `/relay/`) and polling everywhere else.
     */
    async liveTransport(): Promise<LiveTransport> {
        const live = (await this.describe())?.transport?.live;
        if (live === 'poll' || live === 'long-poll' || live === 'websocket') {
            return live;
        }
        return new URL(this.serverUrl).pathname.startsWith('/relay/') ? 'websocket' : 'poll';
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

    /** Which commands members may use room-wide; `null` for a command puts it back to the built-in default. Owner or admin. */
    setRoomPermissions(roomId: string, credential: string, permissions: PermissionChange): Promise<RoomSnapshot> {
        return this.call('POST', `/v1/rooms/${roomId}/permissions`, credential, {permissions});
    }

    /** One member's own allowances and refusals; `null` for a command makes them follow the room again. Owner or admin. */
    setParticipantPermissions(roomId: string, credential: string, participantId: string, permissions: PermissionChange): Promise<RoomSnapshot> {
        return this.call('POST', `/v1/rooms/${roomId}/participants/${participantId}/permissions`, credential, {permissions});
    }

    /** Stores a file on the relay and returns what to put in a message's `attachments`. It is not in the room until a message carries it. */
    async uploadFile(roomId: string, credential: string, name: string, bytes: Uint8Array, mediaType = 'application/octet-stream'): Promise<Attachment> {
        const response = await this.raw('POST', `/v1/rooms/${roomId}/files?name=${encodeURIComponent(name)}`, credential, {body: bytes as Uint8Array<ArrayBuffer>, contentType: mediaType, size: bytes.byteLength});
        return (JSON.parse(await response.text()) as {file: Attachment}).file;
    }

    async uploadFileStream(roomId: string, credential: string, upload: StreamUpload): Promise<Attachment> {
        if (!(await this.describe(true))?.features?.includes('stream-files')) {
            // Older hosted relays require a transport Content-Length. Fetch supplies it for the legacy byte-body API.
            if (!Number.isSafeInteger(upload.size) || upload.size <= 0 || upload.size > ABSOLUTE_MAX_FILE_BYTES) {
                throw new ProtocolError('payload_too_large', 'this file exceeds the supported upload size');
            }
            const bytes = new Uint8Array(upload.size);
            const reader = upload.body.getReader();
            let offset = 0;
            try {
                for (;;) {
                    const {done, value} = await reader.read();
                    if (done) {
                        break;
                    }
                    if (offset + value.byteLength > upload.size) {
                        throw new ProtocolError('invalid_request', 'the upload length changed');
                    }
                    bytes.set(value, offset);
                    offset += value.byteLength;
                }
                if (offset !== upload.size) {
                    throw new ProtocolError('invalid_request', 'the upload length changed');
                }
            } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
            return this.uploadFile(roomId, credential, upload.name, bytes, upload.mediaType);
        }
        const response = await this.raw('POST', `/v1/rooms/${roomId}/files?name=${encodeURIComponent(upload.name)}`, credential, {body: upload.body, contentType: upload.mediaType ?? 'application/octet-stream', size: upload.size});
        return (await response.json() as {file: Attachment}).file;
    }

    async files(roomId: string, credential: string): Promise<RoomFile[]> {
        return (await this.fileList(roomId, credential)).files;
    }

    /** The room's files and, from a relay that reports it, how much of its file storage they take. */
    fileList(roomId: string, credential: string): Promise<ListFilesResponse> {
        return this.call<ListFilesResponse>('GET', `/v1/rooms/${roomId}/files`, credential);
    }

    /** The file's bytes, checked against the digest the relay recorded for it. */
    async downloadFile(roomId: string, credential: string, fileId: string): Promise<Uint8Array> {
        return new Uint8Array(await new Response(await this.downloadFileStream(roomId, credential, fileId)).arrayBuffer());
    }

    /** Integrity is checked at EOF. Consumers must discard partial output when the stream fails. */
    async downloadFileStream(roomId: string, credential: string, fileId: string): Promise<ReadableStream<Uint8Array>> {
        const response = await this.raw('GET', `/v1/rooms/${roomId}/files/${fileId}`, credential);
        if (!response.body) {
            throw new ProtocolError('server_unavailable', 'the file response has no body');
        }
        const expected = response.headers.get('pairlobby-file-sha256');
        const length = response.headers.get('content-length');
        const hash = sha256.create();
        let received = 0;
        return response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                received += chunk.byteLength;
                if (length !== null && received > Number(length)) {
                    throw new ProtocolError('server_unavailable', 'the file arrived with an incorrect length');
                }
                hash.update(chunk);
                controller.enqueue(chunk);
            },
            flush() {
                const digest = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
                if ((expected && expected !== digest) || (length !== null && received !== Number(length))) {
                    throw new ProtocolError('server_unavailable', 'the file arrived damaged; try again');
                }
            }
        }));
    }

    /** A request whose body or answer is bytes rather than JSON. Errors still come back as `ProtocolError`. */
    private async raw(method: string, path: string, credential: string, upload?: RawUpload): Promise<Response> {
        const headers = new Headers({[PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION), authorization: `Bearer ${credential}`});
        if (upload) {
            headers.set('content-type', upload.contentType);
            headers.set(FILE_SIZE_HEADER, String(upload.size));
        }
        let response: Response;
        try {
            const init: StreamingRequestInit = {method, headers, redirect: 'error', signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000), ...(upload ? {body: upload.body, duplex: 'half'} : {})};
            response = await fetch(`${this.serverUrl}${path}`, init);
        } catch (error) {
            const unavailable = new ProtocolError('server_unavailable', `could not reach ${this.serverUrl}: ${error instanceof Error ? error.message : String(error)}`);
            unavailable.cause = error;
            throw unavailable;
        }
        if (!response.ok) {
            throw toProtocolError(response.status, await response.text());
        }
        return response;
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

    /** With `receiptsAfter`, also the receipt watermarks that moved since that revision, which only the relay itself has. */
    readEvents(roomId: string, credential: string, after: number, limit = 200, options: ReadEventsOptions = {}): Promise<ReadEventsResponse> {
        if (options.receiptsAfter !== undefined) {
            return this.call('GET', `/v1/rooms/${roomId}/events?after=${after}&limit=${limit}&receiptsAfter=${options.receiptsAfter}`, credential);
        }
        if (this.liveRoom === roomId && this.socket?.readyState === WebSocket.OPEN && (after === 0 || after >= this.earliestSeq - 1)) {
            const events = this.liveEvents.filter((event) => event.seq > after).slice(0, limit);
            if ((events.length > 0 && events.every((event, index) => event.seq === after + index + 1)) || after === this.watermark) {
                return Promise.resolve({events, earliestSeq: this.earliestSeq, latestSeq: this.watermark, hasMore: (events.at(-1)?.seq ?? after) < this.watermark});
            }
        }
        return this.call('GET', `/v1/rooms/${roomId}/events?after=${after}&limit=${limit}`, credential);
    }

    /** One response carries events and changed-state revisions; callers keep their own consumption cursors. */
    syncEvents(roomId: string, credential: string, options: SyncEventsOptions): Promise<ReadEventsResponse> {
        const wait = Math.min(options.waitMs ?? 0, MAX_EVENT_WAIT_MS);
        const query = new URLSearchParams({after: String(options.after), limit: String(options.limit ?? 200), wait: String(wait), stateAfter: String(options.stateAfter), receiptsAfter: String(options.receiptsAfter ?? 0)});
        if (options.snapshotAfter !== undefined) {
            query.set('snapshotAfter', String(options.snapshotAfter));
        }
        return this.call('GET', `/v1/rooms/${roomId}/events?${query}`, credential, undefined, wait + 15_000, options.signal);
    }

    get liveStateRevision(): number {
        return this.liveRevision;
    }

    get liveLatestSeq(): number {
        return this.watermark;
    }

    reconcileLive(): void {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({type: 'state'}));
        }
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
    async deferForProvider(roomId: string, credential: string, requestId: string, token: string, providerWait: ProviderWait): Promise<void> {
        await this.call('POST', `/v1/rooms/${roomId}/requests/${requestId}/defer`, credential, {...providerWait, token});
    }
    resumeAfterProvider(roomId: string, credential: string, requestId: string): Promise<MessageRequest> {
        return this.call('POST', `/v1/rooms/${roomId}/requests/${requestId}/resume`, credential, {});
    }
    async pendingRequests(roomId: string, credential: string, recipientId?: string): Promise<MessageRequest[]> {
        const requests: MessageRequest[] = [];
        let after = 0;
        for (let pageNumber = 0; pageNumber < 1101; pageNumber++) {
            const page = await this.requests(roomId, credential, after, 100, recipientId);
            requests.push(...page.requests);
            if (requests.length > 1100) {
                throw new ProtocolError('server_unavailable', 'pending request limit exceeded; inbox cannot be verified');
            }
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
    resolveRequest(roomId: string, credential: string, eventId: string, action: 'dismiss' | 'cancel', reason?: string): Promise<RequestResolutionResult> {
        return this.call('POST', `/v1/rooms/${roomId}/requests/${eventId}/resolve`, credential, {action, ...(reason ? {reason} : {})});
    }
    /** This participant has received every event up to `throughSeq`; only on a relay listing `receipt-watermark`. */
    postReceipt(roomId: string, credential: string, throughSeq: number): Promise<ReceiptResponse> {
        return this.call('POST', `/v1/rooms/${roomId}/receipts`, credential, {throughSeq});
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
    async reply(roomId: string, credential: string, eventId: string, text: string, progress = false, turnToken?: string, attachments: Attachment[] = []): Promise<SendEventResponse> {
        const target = await this.request(roomId, credential, eventId);
        if (target.receivedAt === null) {
            await this.acknowledgeMessage(roomId, credential, eventId);
        }
        return this.send(roomId, credential, {
            type: 'message',
            recipientId: target.from,
            replyTo: target.eventId,
            ...(turnToken ? {turnToken} : {}),
            payload: {text, priority: 'normal', responseStage: progress ? 'progress' : 'final', ...(attachments.length ? {attachments} : {})},
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

    /** Puts the agent holding `credential` in the directory, or updates its listing; needs this client's personal token. */
    async shareListing(credential: string, listing: ShareListingRequest): Promise<ListingView> {
        return (await this.call<ListingResponse>('POST', '/v1/directory/listings', credential, listing)).listing;
    }

    /** The heartbeat: what the listed agent is doing now. */
    async listingPresence(listingId: string, credential: string, presence: ListingPresenceRequest): Promise<ListingView> {
        return (await this.call<ListingResponse>('PUT', `/v1/directory/listings/${listingId}/presence`, credential, presence)).listing;
    }

    /** The shared agents this client's member sees: one owner's, by handle, or everyone's. */
    directoryPage(options: DirectoryReadOptions = {}): Promise<DirectoryResponse> {
        const query = new URLSearchParams();
        if (options.owner) {
            query.set('owner', options.owner.replace(/^@/, ''));
        }
        if (options.after) {
            query.set('after', options.after);
        }
        if (options.limit !== undefined) {
            query.set('limit', String(options.limit));
        }
        return this.call('GET', `/v1/directory${query.size ? `?${query}` : ''}`, null);
    }

    async directory(owner?: string): Promise<DirectoryResponse> {
        const result: DirectoryResponse = {listings: []};
        let after: string | undefined;
        for (;;) {
            const page = await this.directoryPage({...(owner ? {owner} : {}), ...(after ? {after} : {})});
            result.listings.push(...page.listings);
            if (page.knownHandle !== undefined) {
                result.knownHandle = Boolean(result.knownHandle || page.knownHandle);
            }
            if (!page.next) {
                return result;
            }
            if (after && page.next <= after) {
                throw new ProtocolError('server_unavailable', 'directory pagination did not advance');
            }
            after = page.next;
        }
    }

    /** A single-use code into a shared agent's room, for this client's member. */
    contact(listingId: string): Promise<ContactResponse> {
        return this.call('POST', `/v1/directory/listings/${listingId}/contact`, null, {});
    }

    /** Takes a listing down, with the personal token or the listed agent's credential. */
    async unshareListing(listingId: string, credential: string | null): Promise<void> {
        await this.call('DELETE', `/v1/directory/listings/${listingId}`, credential);
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

    /** Joins a room open to the relay's local network, as a member. The relay checks where the request comes from. */
    async joinOnLocalNetwork(roomId: string, identity: ClientIdentity): Promise<JoinedRoom> {
        const participantCredential = newCredential('participant');
        const body = await this.call<{roomId: string; participantId: string; role: ParticipantRole; room: RoomSnapshot}>('POST', `/v1/rooms/${roomId}/local-join`, null, {
            participantCredential,
            ...identity
        });
        return {roomId: body.roomId, participantId: body.participantId, participantCredential, role: body.role, room: body.room};
    }

    /**
     * Rooms on this relay that its local network may join by name. Null when the relay
     * cannot be reached, predates local joins, or does not count this device as local.
     * Never throws: a device looking for a room asks several relays.
     */
    async localRooms(name?: string, timeoutMs = 1500): Promise<LocalRoom[] | null> {
        try {
            // Without a name the relay lists them all; one that predates listing answers 400, hence null.
            // On a relay with personal tokens, the login decides which rooms are listed.
            const response = await fetch(`${this.serverUrl}/v1/rooms/local${name === undefined ? '' : `?name=${encodeURIComponent(name)}`}`, {headers: {[PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION), ...(this.accountToken ? {'x-pairlobby-account-token': this.accountToken} : {})}, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
            if (!response.ok) {
                return null;
            }
            const body = (await response.json()) as {rooms?: unknown};
            return Array.isArray(body.rooms) ? (body.rooms as LocalRoom[]) : null;
        } catch {
            return null;
        }
    }

    /**
     * Invites an account to a hosted room by its handle. The room credential must be
     * the owner's or an admin's, and this client needs the inviter's account token:
     * the person invited is told who asked.
     */
    async inviteAccount(roomId: string, credential: string, handle: string, role: 'member' | 'observer' = 'member'): Promise<RoomInvitation> {
        return (await this.call<{invitation: RoomInvitation}>('POST', `/v1/rooms/${roomId}/invitations`, credential, {handle, role})).invitation;
    }

    /** A hosted room's unanswered and accepted invitations, newest first. */
    async roomInvitations(roomId: string, credential: string): Promise<RoomInvitation[]> {
        return (await this.call<{invitations: RoomInvitation[]}>('GET', `/v1/rooms/${roomId}/invitations`, credential)).invitations;
    }

    /** Withdraws an invitation nobody has answered yet. */
    async revokeInvitation(roomId: string, credential: string, invitationId: string): Promise<void> {
        await this.call('DELETE', `/v1/rooms/${roomId}/invitations/${invitationId}`, credential);
    }

    setLocalJoin(roomId: string, credential: string, localJoin: boolean): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/local-access`, credential, {localJoin});
    }

    setRoomType(roomId: string, credential: string, type: RoomType): Promise<RoomEventResult> {
        return this.call('POST', `/v1/rooms/${roomId}/type`, credential, {type});
    }

    /** Sets who sees the room; the event is null when it already was. */
    setVisibility(roomId: string, credential: string, visibility: RoomVisibility): Promise<{event: RoomEvent | null}> {
        return this.call('PUT', `/v1/rooms/${roomId}/visibility`, credential, {visibility});
    }

    /** The logged-in member's default visibility for their rooms. Needs the account token. */
    async memberDefault(): Promise<DefaultVisibility> {
        return (await this.call<{visibility: DefaultVisibility}>('GET', '/v1/directory/defaults', null)).visibility;
    }

    async setMemberDefault(visibility: DefaultVisibility): Promise<DefaultVisibility> {
        return (await this.call<{visibility: DefaultVisibility}>('PUT', '/v1/directory/defaults', null, {visibility})).visibility;
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

    /** Incremental export for current relays; preserves compatibility with an older relay's JSON endpoint. */
    async *exportRecords(roomId: string, credential: string): AsyncGenerator<ExportStreamRecord> {
        if (!(await this.describe())?.features?.includes('stream-export')) {
            const {events, ...metadata} = await this.export(roomId, credential);
            yield {kind: 'metadata', metadata};
            for (const event of events) {
                yield {kind: 'event', event};
            }
            yield {kind: 'complete', events: events.length};
            return;
        }
        const response = await this.raw('GET', `/v1/rooms/${roomId}/export?format=ndjson`, credential);
        if (!response.body) {
            throw new ProtocolError('server_unavailable', 'the export response has no body');
        }
        let started = false;
        let complete = false;
        let count = 0;
        for await (const line of exportLines(response.body)) {
            const record = ExportStreamRecord.parse(JSON.parse(line));
            if (complete || (record.kind === 'metadata' ? started : !started)) {
                throw new ProtocolError('server_unavailable', 'the export records arrived out of order');
            }
            if (record.kind === 'metadata') {
                started = true;
            } else if (record.kind === 'event') {
                count++;
            } else {
                if (record.events !== count) {
                    throw new ProtocolError('server_unavailable', 'the export ended before all events arrived');
                }
                complete = true;
            }
            yield record;
        }
        if (!complete) {
            throw new ProtocolError('server_unavailable', 'the export did not finish; retry');
        }
    }

    async delete(roomId: string, credential: string): Promise<void> {
        await this.call('DELETE', `/v1/rooms/${roomId}`, credential);
    }

    /**
     * Returns when something newer than `after` may be in the room, or at `timeoutMs`. Uses the relay's
     * transport: a socket, a held read, or a sleep of `localIntervalMs` before the caller reads again.
     */
    async waitForChange(roomId: string, credential: string, after: number, timeoutMs: number, localIntervalMs = 1000, options: LiveWaitOptions = {}): Promise<void> {
        const transport = await this.liveTransport();
        const cancelled = this.liveWait.signal;
        if (transport === 'long-poll') {
            const waitMs = Math.min(timeoutMs, MAX_EVENT_WAIT_MS);
            try {
                await this.call('GET', `/v1/rooms/${roomId}/events?after=${after}&limit=1&wait=${waitMs}`, credential, undefined, waitMs + 10_000, cancelled);
            } catch {
                if (!cancelled.aborted) {
                    // A relay that is restarting or gone: wait as polling would, and let the caller's next read report it.
                    await sleep(Math.min(timeoutMs, localIntervalMs), cancelled);
                }
            }
            return;
        }
        if (transport === 'poll') {
            await sleep(Math.min(timeoutMs, localIntervalMs), cancelled);
            return;
        }
        if (this.liveRoom !== roomId) {
            this.closeLive();
        }
        if (!this.socket) {
            this.connecting ??= this.openSocket(roomId, credential, after).finally(() => { this.connecting = null; });
            await this.connecting;
        }
        if (this.watermark > after || (options.stateAfter !== undefined && this.liveRevision > options.stateAfter)) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const finish = () => {
                if (this.watermark <= after && (options.stateAfter === undefined || this.liveRevision <= options.stateAfter) && this.socket) {
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

    private async openSocket(roomId: string, credential: string, after: number): Promise<void> {
        const cancelled = this.liveWait.signal;
        this.liveRoom = roomId;
        const {ticket} = await this.call<{ticket: string}>('POST', `/v1/rooms/${roomId}/connect-ticket`, credential, {sync: true, connectionId: this.connectionId}, undefined, cancelled);
        if (cancelled.aborted) {
            return;
        }
        const url = new URL(`${this.serverUrl}/v1/rooms/${roomId}/connect`);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('ticket', ticket);
        const socket = new WebSocket(url);
        this.socket = socket;
        this.liveRoom = roomId;
        this.watermark = after;
        socket.addEventListener('message', (event) => {
            if (event.data === 'pong') {
                return;
            }
            let raw: unknown;
            try {
                raw = JSON.parse(String(event.data));
                const frame = ServerFrame.parse(raw);
                if (frame.type === 'hello') {
                    this.watermark = Math.max(this.watermark, frame.watermarkSeq);
                    this.earliestSeq = frame.snapshot.earliestSeq;
                    this.liveRevision = Math.max(this.liveRevision, frame.snapshot.stateRevision ?? 0);
                }
                if (frame.type === 'state' && frame.roomId === roomId) {
                    this.liveRevision = Math.max(this.liveRevision, frame.stateRevision);
                    this.watermark = Math.max(this.watermark, frame.latestSeq);
                    this.earliestSeq = Math.max(this.earliestSeq, frame.earliestSeq ?? 1);
                    this.liveEvents = this.liveEvents.filter((event) => event.seq >= this.earliestSeq);
                    this.liveBytes = this.liveEvents.reduce((size, event) => size + new TextEncoder().encode(JSON.stringify(event)).byteLength, 0);
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
                    this.liveEvents = [];
                    this.liveBytes = 0;
                    this.watermark = Math.max(this.watermark, raw.event.seq);
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

    closeLive(): void {
        this.liveWait.abort();
        this.liveWait = new AbortController();
        const socket = this.socket;
        this.socket = null;
        this.liveRoom = null;
        this.watermark = 0;
        this.liveRevision = 0;
        this.liveEvents = [];
        this.liveBytes = 0;
        socket?.close();
        for (const wake of this.changed) wake();
    }

    private async call<T>(method: string, path: string, credential: string | null, body?: unknown, timeoutMs?: number, cancelled?: AbortSignal): Promise<T> {
        const headers = new Headers({[PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION)});
        if (credential) {
            headers.set('authorization', `Bearer ${credential}`);
        }
        if (this.accountToken && ((method === 'POST' && (path === '/v1/rooms' || path === '/v1/invites/redeem' || path.endsWith('/account-join') || path.endsWith('/invitations') || path.endsWith('/local-join'))) || path.startsWith('/v1/directory'))) {
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
                signal: AbortSignal.any([...(this.signal ? [this.signal] : []), ...(cancelled ? [cancelled] : []), AbortSignal.timeout(timeoutMs ?? (path.endsWith('/export') ? 60_000 : 15_000))]),
                ...(body === undefined ? {} : {body: JSON.stringify(body)})
            });
        } catch (error) {
            // An untrusted certificate is not an outage: retrying will not help, and the person needs to know which it is.
            const untrusted = untrustedCertificate(error);
            throw new ProtocolError('server_unavailable', `could not reach ${this.serverUrl}${untrusted ? `: its certificate is not trusted on this machine (${untrusted}). On a company network that inspects traffic, set PAIRLOBBY_CA_FILE to the company root certificate` : ''}`, {retryAfterMs: 1000});
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

/** Resolves after `ms`, or as soon as `cancelled` aborts. */
function sleep(ms: number, cancelled: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (cancelled.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(done, ms);
        function done(): void {
            clearTimeout(timer);
            cancelled.removeEventListener('abort', done);
            resolve();
        }
        cancelled.addEventListener('abort', done, {once: true});
    });
}

type UnknownEventFrame = {type: 'event'; event: {seq: number}};

async function* exportLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let pending = '';
    try {
        for (;;) {
            const {done, value} = await reader.read();
            pending += done ? decoder.decode() : decoder.decode(value, {stream: true});
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
                if (end > 8 * 1024 * 1024) {
                    throw new ProtocolError('payload_too_large', 'an export record is too large');
                }
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                if (line.trim()) {
                    yield line;
                }
            }
            if (pending.length > 8 * 1024 * 1024) {
                throw new ProtocolError('payload_too_large', 'an export record is too large');
            }
            if (done) {
                if (pending.trim()) {
                    throw new ProtocolError('server_unavailable', 'the export ended within a record');
                }
                break;
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

function isEventFrame(value: unknown): value is UnknownEventFrame {
    const frame = value as {type?: unknown; event?: {seq?: unknown}} | null;
    return typeof frame === 'object' && frame !== null && frame.type === 'event' && typeof frame.event?.seq === 'number';
}

const UNTRUSTED_CERTIFICATE = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED']);

/** The TLS error code when a request failed because the server's certificate chain is not trusted, else null. */
function untrustedCertificate(error: unknown): string | null {
    for (let cause: unknown = error, depth = 0; cause && depth < 5; cause = (cause as {cause?: unknown}).cause, depth++) {
        const code = String((cause as {code?: unknown}).code);
        if (UNTRUSTED_CERTIFICATE.has(code)) {
            return code;
        }
    }
    return null;
}

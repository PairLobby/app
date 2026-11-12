//! Room operations shared by every transport. The Cloudflare Durable Object and
//! the Node server both run this; only the store and the socket layer differ.

import {sha256} from '@noble/hashes/sha2.js';
import {ABSOLUTE_MAX_FILE_BYTES, CONTACT_INVITE_LIFETIME_MS, MOVE_LEASE_MS, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_RETAINED_FILE_BYTES, DEFAULT_ROOM_POLICY, FILE_CHUNK_BYTES, PROTOCOL_VERSION, ProtocolError, UNATTACHED_FILE_LIFETIME_MS, canSee, formatFileSize, hashCredential, newId, newInviteCode, normalizeInviteCode, roomType, safeFileName} from '@pairlobby/protocol';
import type {
    AdapterCapabilities,
    Attachment,
    AutoClosePolicy,
    ContactResponse,
    ListingRecord,
    MovedTo,
    DefaultVisibility,
    FileRecord,
    MessageRequest,
    RequestPage,
    ExportResponse,
    ListFilesResponse,
    ParticipantKind,
    PermissionChange,
    PermissionSet,
    RenameSelfRequest,
    NameSource,
    ParticipantRole,
    ParticipantRecord,
    ReadEventsResponse,
    ReceiptMode,
    ReceiptResponse,
    ReceiptUpdate,
    RelayLimits,
    RoomRecord,
    RoomEvent,
    RoomInvitationChange,
    RoomPolicy,
    RoomType,
    RoomVisibility,
    RoomSnapshot,
    ResolveRequestRequest,
    RoomFile,
    SendEventRequest
} from '@pairlobby/protocol';
import {
    assertRoomWritable,
    assertRoomReadable,
    appendEvent,
    assertRoomJoinable,
    assertCanWrite,
    assertCanAcknowledge,
    assertActiveMember,
    assertController,
    assertPermitted,
    authenticate,
    closeMovedRoom,
    closeRoom,
    createRoom,
    joinAsGuest,
    joinOnLocalNetwork,
    recordInvitation,
    joinRoom,
    leaveRoom,
    rejoinRoom,
    renameRoom,
    renameSelf,
    requestControl,
    revokeParticipant,
    sendEvent,
    setExpiry,
    setAutoClose,
    setInviteRole,
    setJoinPolicy,
    setLocalJoin,
    setLocked,
    setMuted,
    setParticipantPermissions,
    setParticipantRole,
    setRoomPermissions,
    setRoomType,
    setRoomVisibility,
    emptyMutation,
    findParticipant,
    isActive,
    toSnapshot
} from '@pairlobby/room-core';
import type {Actor, Mutation, RoomView} from '@pairlobby/room-core';

import {stableStringify} from './stable-json.js';
import {TurnCoordinator, assertTurn} from './turns.js';
import type {FileStore, RoomHead, RoomStore} from './store.js';
import {AutoCloseStore} from './auto-close-store.js';
import {retryRoomConflict} from './commit.js';
import {exportResponse, retainedEvents, transferResponse} from './export.js';
import type {ExportFormat, ExportSource} from './export.js';

type InviteDirectory = {
    reserve(code: string, roomId: string, expiresAt: number | null): Promise<boolean>;
};

type MintedInvite = {code: string; expiresAt: number | null; reusable: boolean};

type SentEventResult = {event: RoomEvent; deduplicated: boolean};
type AuthorizedRoom = {head: RoomHead; actor: Actor};
export type SyncReadOptions = {stateAfter: number; snapshotAfter?: number | undefined};
export type RoomConnection = {snapshot: RoomSnapshot; participantId: string};

/** Membership authorization for a transport attachment that was authenticated when issued. */
export function assertConnectedParticipant(snapshot: RoomSnapshot, participantId: string): void {
    const participant = snapshot.participants.find((entry) => entry.participantId === participantId);
    if (!participant || participant.revoked || participant.left) {
        throw new ProtocolError('participant_revoked', 'this participant is no longer in the room');
    }
}
export type RequestResolutionResult = {event: RoomEvent; request: MessageRequest; deduplicated: boolean};

type GuestJoinInput = Identity & {participantCredential: string; member?: string | undefined};

export interface InterruptResult {
    event: RoomEvent;
    /** Requests whose running turn was fenced; empty when the agent was between turns. */
    fenced: string[];
}

/** One scheduler pass: rooms closed, whether more were already due, and the next deadline. */
export interface AutoCloseSweep {
    closed: number;
    more: boolean;
    nextAt: number | null;
}

export interface Identity {
    displayName: string;
    nameSource?: NameSource | undefined;
    kind: ParticipantKind;
    sessionId?: string | undefined;
    capabilities?: AdapterCapabilities | undefined;
    /** The relay member joining, verified by the relay from a personal token. Never taken from a client request. */
    member?: string | undefined;
}

export interface CreateRoomInput extends Identity {
    name: string;
    controllerCredential: string;
    participantCredential: string;
    expiresAt?: number | null | undefined;
    policy?: RoomPolicy;
    /** Absent creates a room without a type, as before types existed. */
    type?: RoomType | undefined;
    /**
     * Chosen by a server that routes by room id before the room exists, such as a
     * relay with one Durable Object per room. Never taken from a client request.
     */
    roomId?: string;
    /** The relay member creating the room, verified by the relay from a personal token. Never taken from a client request. */
    owner?: string | undefined;
    /** Who sees the room; needs an owner. Absent means the owner's default. */
    visibility?: RoomVisibility | undefined;
}

export interface CreatedRoom {
    roomId: string;
    participantId: string;
    invite: {code: string; expiresAt: number | null};
    snapshot: RoomSnapshot;
}

export interface RedeemInput extends Identity {
    useInviteName?: boolean | undefined;
    code: string;
    attemptId: string;
    participantCredential: string;
}

export interface RedeemResult {
    roomId: string;
    participantId: string;
    role: ParticipantRole;
    replayed: boolean;
    snapshot: RoomSnapshot;
}

export type FileUpload = {name: string; mediaType: string; bytes: Uint8Array};
export type FileDownload = {file: FileRecord; bytes: Uint8Array};
export type FileStreamUpload = {name: string; mediaType: string; size: number; body: ReadableStream<Uint8Array>; signal?: AbortSignal};
export type FileStreamDownload = {file: FileRecord; body: ReadableStream<Uint8Array>};
export type RoomOperation = <T>(action: () => Promise<T>) => Promise<T>;
type UploadPermission = {view: RoomView; uploaderId: string; retained: number};

export type Clock = () => number;

export type RelayProfile = {files: boolean; limits: RelayLimits; receiptMode: ReceiptMode};

/** The agent a listing shares, with the names readers see, as of `at`. */
export type ListingSubject = {participantId: string; agentName: string; roomName: string; at: number};

export type RoomServiceOptions = {
    /** How plain receipts are kept (`RECEIPT_MODES`); `both` until every client in use reads watermarks. */
    receiptMode?: ReceiptMode;
    /** A member's default visibility for their rooms, from the directory; absent or null means everyone. */
    memberDefault?: (handle: string) => Promise<DefaultVisibility | null>;
};

/** Why a code made by a member, or a join by name, did not let someone in. */
const NOT_VISIBLE = 'the room\'s owner has not let you see this room: ask them for a code, or log in to the relay as someone who can see it (pairlobby login)';

/** A receipt that only says the message arrived: no Read stage, no action. */
function isPlainReceipt(request: SendEventRequest): boolean {
    return request.type === 'message.received' && !request.payload.stage && !request.payload.action;
}

/** The room with this participant's watermark moved up to `throughSeq`, never past the last event; the same room when it would not move. */
export function withReceipt(room: RoomRecord, participantId: string, throughSeq: number, at: number): RoomRecord {
    const through = Math.min(throughSeq, room.nextSeq - 1);
    if (through <= (room.receipts?.[participantId]?.throughSeq ?? 0)) {
        return room;
    }
    const revision = (room.receiptRevision ?? 0) + 1;
    return {...room, receipts: {...room.receipts, [participantId]: {throughSeq: through, revision, at}}, receiptRevision: revision};
}

/** The watermarks that moved after `after`, for a read that asked for them. */
export function receiptsSince(room: RoomRecord, after: number): {receipts: ReceiptUpdate[]; receiptRevision: number} {
    const receipts = Object.entries(room.receipts ?? {}).filter(([, mark]) => mark.revision > after).map(([participantId, mark]) => ({participantId, ...mark}));
    return {receipts: receipts.sort((a, b) => a.revision - b.revision), receiptRevision: room.receiptRevision ?? 0};
}

/** The limits a new room gets under `policy`, as a relay reports them; file limits only where files are kept. */
export function relayLimits(policy: RoomPolicy, files: boolean): RelayLimits {
    return {
        maxParticipants: policy.maxParticipants,
        maxEventPayloadBytes: policy.maxEventPayloadBytes,
        maxRetainedEvents: policy.maxRetainedEvents,
        maxRetainedEventBytes: policy.maxRetainedEventBytes,
        ...(files ? {maxFileBytes: Math.min(policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, ABSOLUTE_MAX_FILE_BYTES), maxRetainedFileBytes: policy.maxRetainedFileBytes ?? DEFAULT_MAX_RETAINED_FILE_BYTES} : {})
    };
}

export class RoomService {
    private readonly store: RoomStore;
    private readonly now: Clock;
    readonly turns: TurnCoordinator;
    readonly receiptMode: ReceiptMode;
    private readonly memberDefault: (handle: string) => Promise<DefaultVisibility | null>;

    /**
     * `roomPolicy` is what a new room gets when the caller names no policy, such as a
     * self-hosted relay's configured limits. Existing rooms keep the policy they were made with.
     */
    constructor(
        store: RoomStore,
        now: Clock = () => Date.now(),
        private readonly directory?: InviteDirectory,
        private readonly roomPolicy: RoomPolicy = DEFAULT_ROOM_POLICY,
        options: RoomServiceOptions = {}
    ) {
        this.now = now;
        this.receiptMode = options.receiptMode ?? 'both';
        this.memberDefault = options.memberDefault ?? (async () => null);
        this.store = new AutoCloseStore(store, () => this.now());
        this.turns = new TurnCoordinator(this.store, now);
    }

    private ctx() {
        return {now: this.now(), newEventId: () => newId('event')};
    }

    private async view(roomId: string, handovers = false): Promise<RoomView> {
        const view = await this.store.loadRoom(roomId, {handovers});
        if (!view) {
            throw new ProtocolError('room_not_found', 'no such room');
        }
        return view;
    }

    /** Reading events or requests needs one credential, not every past member and handover. */
    private async reader(roomId: string, credential: string): Promise<AuthorizedRoom> {
        const head = await this.store.roomHead(roomId);
        if (!head) {
            throw new ProtocolError('room_not_found', 'no such room');
        }
        const hash = await hashCredential(credential);
        const participant = await this.store.participantByCredential(roomId, hash);
        const actor = authenticate({...head, participants: participant ? [participant] : [], controls: [], handovers: []}, hash, this.now());
        return {head, actor};
    }

    /** What the room looks like, plus what this relay can do that depends on its store rather than on the room. */
    private snapshotOf(view: RoomView): RoomSnapshot {
        return {...toSnapshot(view), filesSupported: this.store.files !== undefined, moveSupported: this.store.transferOut !== undefined, receiptMode: this.receiptMode};
    }

    /** Whether rooms here keep files, and the limits a new room gets: what `GET /v1/server` reports. */
    relayProfile(): RelayProfile {
        const files = this.store.files !== undefined;
        return {files, limits: relayLimits(this.roomPolicy, files), receiptMode: this.receiptMode};
    }

    private fileStore(): FileStore {
        if (!this.store.files) {
            throw new ProtocolError('unsupported_capability', 'this relay does not store files');
        }
        return this.store.files;
    }

    /**
     * Stores a file so a later message can carry it. Nothing is in the room until
     * that message is sent; an upload nobody sends is removed after an hour.
     */
    async uploadFile(roomId: string, credential: string, upload: FileUpload): Promise<Attachment> {
        const files = this.fileStore();
        const credentialHash = await hashCredential(credential);
        const size = upload.bytes.byteLength;
        const {uploaderId} = await this.uploadPermission(roomId, credentialHash, size);
        const now = this.now();
        await files.deleteUnattachedFiles(roomId, now - UNATTACHED_FILE_LIFETIME_MS);
        const digest = hexDigest(sha256(upload.bytes));
        const file = this.uploadRecord(roomId, uploaderId, upload.name, upload.mediaType, size, digest, now);
        await retryRoomConflict(async () => {
            const {view, retained} = await this.uploadPermission(roomId, credentialHash, size);
            if (!(await files.putFile(file, upload.bytes, retained, view.room.stateRevision ?? 0))) {
                throw new ProtocolError('quota_exceeded', `this room has reached its file storage limit of ${formatFileSize(retained)}`);
            }
        });
        return toAttachment(file);
    }

    private async uploadPermission(roomId: string, credentialHash: string, size: number): Promise<UploadPermission> {
        const view = await this.view(roomId);
        const now = this.now();
        const actor = authenticate(view, credentialHash, now);
        assertRoomWritable(view, now);
        const sender = assertCanWrite(actor);
        assertPermitted(view, actor, 'attach');
        const limit = Math.min(view.room.policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, ABSOLUTE_MAX_FILE_BYTES);
        if (limit === 0) {
            throw new ProtocolError('unsupported_capability', 'this room does not accept files');
        }
        if (size === 0) {
            throw new ProtocolError('invalid_request', 'an empty file cannot be attached');
        }
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new ProtocolError('invalid_request', 'a file needs a positive, declared byte length');
        }
        if (size > limit) {
            throw new ProtocolError('payload_too_large', `this file is ${formatFileSize(size)}; this room accepts files up to ${formatFileSize(limit)}`);
        }
        return {view, uploaderId: sender.participantId, retained: view.room.policy.maxRetainedFileBytes ?? DEFAULT_MAX_RETAINED_FILE_BYTES};
    }

    private uploadRecord(roomId: string, uploaderId: string, name: string, claimedType: string, size: number, digest: string, now: number): FileRecord {
        const baseType = claimedType.split(';')[0]!.trim();
        const mediaType = /^[\w.+-]{1,60}\/[\w.+-]{1,60}$/.test(baseType) ? baseType.toLowerCase() : 'application/octet-stream';
        return {fileId: newId('file'), roomId, uploaderId, name: safeFileName(name), size, mediaType, sha256: digest, createdAt: now, eventId: null};
    }

    /** Reserve quota, stream bounded chunks, and make the upload visible only after validation and fresh authorization. */
    async uploadFileStream(roomId: string, credential: string, upload: FileStreamUpload, run: RoomOperation = (action) => action()): Promise<Attachment> {
        const files = this.fileStore();
        const credentialHash = await hashCredential(credential);
        const {uploaderId} = await run(() => this.uploadPermission(roomId, credentialHash, upload.size));
        const now = this.now();
        await run(() => files.deleteUnattachedFiles(roomId, now - UNATTACHED_FILE_LIFETIME_MS));
        const file = this.uploadRecord(roomId, uploaderId, upload.name, upload.mediaType, upload.size, '', now);
        if (!files.createUpload || !files.writeChunk || !files.completeUpload || !files.cancelUpload) {
            // Compatibility for older in-process adapters. The production SQLite adapters implement staging.
            const bytes = new Uint8Array(upload.size);
            let offset = 0;
            await consumeUpload(upload, async (chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
            return run(() => this.uploadFile(roomId, credential, {name: upload.name, mediaType: upload.mediaType, bytes}));
        }
        await retryRoomConflict(() => run(async () => {
            const {view, retained} = await this.uploadPermission(roomId, credentialHash, upload.size);
            if (!(await files.createUpload!(file, retained, view.room.stateRevision ?? 0))) {
                throw new ProtocolError('quota_exceeded', `this room has reached its file storage limit of ${formatFileSize(retained)}`);
            }
        }));
        try {
            let index = 0;
            const digest = sha256.create();
            await consumeUpload(upload, async (chunk) => {
                digest.update(chunk);
                await run(() => files.writeChunk!(roomId, file.fileId, index++, chunk));
            });
            file.sha256 = hexDigest(digest.digest());
            await retryRoomConflict(() => run(async () => {
                upload.signal?.throwIfAborted();
                const {view} = await this.uploadPermission(roomId, credentialHash, upload.size);
                await files.completeUpload!(file, view.room.stateRevision ?? 0);
            }));
        } catch (error) {
            await run(() => files.cancelUpload!(roomId, file.fileId));
            throw error;
        }
        return toAttachment(file);
    }

    /** Every file a message in this room carries, and how much of its storage they take. Anyone who can read the room can list and fetch them. */
    async listFiles(roomId: string, credential: string): Promise<ListFilesResponse> {
        const files = this.fileStore();
        const view = await this.view(roomId);
        authenticate(view, await hashCredential(credential), this.now());
        const policy = view.room.policy;
        const usage = {usedBytes: await files.usedBytes(roomId), limitBytes: policy.maxRetainedFileBytes ?? DEFAULT_MAX_RETAINED_FILE_BYTES, maxFileBytes: Math.min(policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, ABSOLUTE_MAX_FILE_BYTES)};
        return {files: await this.roomFiles(files, roomId), usage};
    }

    private async roomFiles(files: FileStore, roomId: string): Promise<RoomFile[]> {
        return (await files.attachedFiles(roomId)).map((file) => ({...toAttachment(file), uploaderId: file.uploaderId, createdAt: file.createdAt, eventId: file.eventId!}));
    }

    async downloadFile(roomId: string, credential: string, fileId: string): Promise<FileDownload> {
        const {file, body} = await this.downloadFileStream(roomId, credential, fileId);
        return {file, bytes: new Uint8Array(await new Response(body).arrayBuffer())};
    }

    async downloadFileStream(roomId: string, credential: string, fileId: string): Promise<FileStreamDownload> {
        const files = this.fileStore();
        const actor = authenticate(await this.view(roomId), await hashCredential(credential), this.now());
        const file = await files.file(roomId, fileId);
        // An upload not yet sent is visible to its uploader only, and says no more than a missing file does.
        const visible = file && (file.eventId !== null || (actor.kind === 'participant' && actor.participant.participantId === file.uploaderId));
        let body = visible && files.fileStream ? await files.fileStream(roomId, fileId) : null;
        if (visible && !files.fileStream) {
            const bytes = await files.fileBytes(roomId, fileId);
            body = bytes ? new Response(bytes as Uint8Array<ArrayBuffer>).body : null;
        }
        if (!file || !body) {
            throw new ProtocolError('invalid_request', 'no such file in this room');
        }
        return {file, body};
    }

    /** Replaces what the client said about each file with the relay's own record of it. */
    private async attachments(view: RoomView, actor: ReturnType<typeof authenticate>, claimed: Attachment[]): Promise<Attachment[]> {
        const files = this.fileStore();
        const sender = assertCanWrite(actor);
        assertPermitted(view, actor, 'attach');
        if (new Set(claimed.map((file) => file.fileId)).size !== claimed.length) {
            throw new ProtocolError('invalid_request', 'the same file is attached twice');
        }
        const carried: Attachment[] = [];
        for (const {fileId} of claimed) {
            const file = await files.file(view.room.roomId, fileId);
            if (!file || file.uploaderId !== sender.participantId) {
                throw new ProtocolError('invalid_request', `no upload of yours has the id ${fileId}`);
            }
            if (file.eventId !== null) {
                throw new ProtocolError('invalid_request', `${file.name} was already sent with another message; upload it again to send it again`);
            }
            carried.push(toAttachment(file));
        }
        return carried;
    }

    async createRoom(input: CreateRoomInput): Promise<CreatedRoom> {
        const created = createRoom(
            {
                name: input.name,
                roomId: input.roomId ?? newId('room'),
                controllerCredentialHash: await hashCredential(input.controllerCredential),
                participantCredentialHash: await hashCredential(input.participantCredential),
                displayName: input.displayName,
                kind: input.kind,
                nameSource: input.nameSource,
                sessionId: input.sessionId ?? null,
                capabilities: input.capabilities ?? null,
                ...(input.member ? {member: input.member} : {}),
                ...(input.owner ? {owner: input.owner} : {}),
                ...(input.visibility ? {visibility: input.visibility} : {}),
                ...(input.expiresAt !== undefined ? {expiresAt: input.expiresAt} : {}),
                policy: input.policy ?? this.roomPolicy,
                ...(input.type ? {type: input.type} : {})
            },
            this.ctx()
        );
        await this.store.createRoom(created.mutation.room, created.participant, created.mutation.appendEvent);
        const invite = await this.mintInvite(created.room.roomId, input.controllerCredential, 'member');
        const view = await this.view(created.room.roomId);
        return {roomId: created.room.roomId, participantId: created.participant.participantId, invite, snapshot: this.snapshotOf(view)};
    }

    async mintInvite(roomId: string, credential: string, role: ParticipantRole, reusable = true, expiresAt?: number | null, defaultName?: string): Promise<MintedInvite> {
        return retryRoomConflict(() => this.mintInviteAttempt(roomId, credential, role, reusable, expiresAt, defaultName));
    }

    private async mintInviteAttempt(roomId: string, credential: string, role: ParticipantRole, reusable: boolean, expiresAt?: number | null, defaultName?: string): Promise<MintedInvite> {
        const view = await this.view(roomId);
        const actor = authenticate(view, await hashCredential(credential), this.now());
        assertPermitted(view, actor, 'invite');
        if (role === 'controller') {
            assertController(actor);
        }
        const issuedBy = actor.kind === 'controller' ? 'owner' : actor.participant.role === 'controller' ? 'admin' : 'member';
        if (defaultName !== undefined && (!defaultName.trim() || defaultName.trim().length > 64)) {
            throw new ProtocolError('invalid_request', 'invite name must be between 1 and 64 characters');
        }
        assertRoomJoinable(view, this.now());
        const now = this.now();
        const lifetime = view.room.policy.inviteLifetimeMs;
        const deadline = expiresAt !== undefined ? expiresAt : lifetime === null ? null : now + lifetime;
        const {code, digest} = await this.allocateCode(roomId, deadline);
        await this.store.putInvite({
            digest,
            roomId,
            role,
            createdAt: now,
            expiresAt: deadline,
            state: 'unused',
            ...(defaultName !== undefined ? {defaultName: defaultName.trim()} : {}),
            issuedBy,
            reusable,
            boundAttemptId: null,
            boundCredentialHash: null,
            redeemedParticipantId: null,
            recoverableUntil: deadline === null ? null : deadline + (deadline - now)
        }, view.room.stateRevision ?? 0);
        return {code, expiresAt: deadline, reusable};
    }

    /** A code no invite has, claimed in the directory when there is one. */
    private async allocateCode(roomId: string, deadline: number | null): Promise<{code: string; digest: string}> {
        let code = '',
            normalized = '';
        for (let attempt = 0; attempt < 8; attempt++) {
            code = newInviteCode(this.directory ? 12 : 8);
            normalized = normalizeInviteCode(code)!;
            if (await this.store.inviteByDigest(await hashCredential(normalized))) {
                continue;
            }
            if (!this.directory || (await this.directory.reserve(code, roomId, deadline))) {
                break;
            }
            code = '';
        }
        const digest = await hashCredential(normalized);
        if (!code || (await this.store.inviteByDigest(digest))) {
            throw new ProtocolError('server_unavailable', 'Could not allocate a unique invite; try again');
        }
        return {code, digest};
    }

    /**
     * A single-use code that lets a member who found a shared agent in the directory into its room,
     * as a member who came through the directory, so the agent answers them on the listing's terms.
     * The room checks again that the listing stands and that they see the room.
     */
    async contactInvite(roomId: string, listing: ListingRecord, handle: string): Promise<ContactResponse> {
        return retryRoomConflict(async () => {
            const view = await this.view(roomId);
            const now = this.now();
            const agent = findParticipant(view, listing.participantId);
            if (!agent || !(await this.listable(roomId, listing.participantId)) || !(await this.sees(view.room, handle))) {
                throw new ProtocolError('invalid_request', 'no such listing');
            }
            const expiresAt = now + CONTACT_INVITE_LIFETIME_MS;
            const {code, digest} = await this.allocateCode(roomId, expiresAt);
            await this.store.putInvite({
                digest,
                roomId,
                role: 'member',
                createdAt: now,
                expiresAt,
                state: 'unused',
                // Sharing the agent was the owner's consent; the room was checked against this member just now.
                issuedBy: 'owner',
                origin: {directory: true, handle, listingId: listing.listingId, contact: listing.contact},
                reusable: false,
                boundAttemptId: null,
                boundCredentialHash: null,
                redeemedParticipantId: null,
                recoverableUntil: expiresAt + CONTACT_INVITE_LIFETIME_MS
            }, view.room.stateRevision ?? 0);
            return {code, expiresAt, roomId, agentId: agent.participantId, agentName: agent.displayName, roomName: view.room.name, owner: listing.owner, contact: listing.contact, connection: listing.connection};
        });
    }

    /** Whether a member reaches this listing: it still stands, and they see its room. */
    async listingVisible(listing: ListingRecord, handle: string): Promise<boolean> {
        const view = await this.store.loadRoom(listing.roomId, {handovers: false});
        return Boolean(view && this.listableParticipant(view, listing.participantId) && await this.sees(view.room, handle));
    }

    async visibleListings(listings: ListingRecord[], handle: string): Promise<ListingRecord[]> {
        const rooms = new Map<string, Promise<RoomView | null>>();
        const visible = await Promise.all(listings.map(async (listing) => {
            let loading = rooms.get(listing.roomId);
            if (!loading) {
                loading = this.store.loadRoom(listing.roomId, {handovers: false});
                rooms.set(listing.roomId, loading);
            }
            const view = await loading;
            return Boolean(view && this.listableParticipant(view, listing.participantId) && await this.sees(view.room, handle));
        }));
        return listings.filter((_, index) => visible[index]);
    }

    /**
     * Redemption binds the invite to one attempt before membership exists, so a
     * crash between the two steps leaves a resumable reservation rather than an
     * invite a different stranger can claim.
     */
    /** The room an invite's digest belongs to, for routing before the room checks the code; null when no invite has it. */
    async inviteRoom(digest: string): Promise<string | null> {
        return (await this.store.inviteByDigest(digest))?.roomId ?? null;
    }

    async redeemInvite(input: RedeemInput): Promise<RedeemResult> {
        return retryRoomConflict(() => this.redeemInviteAttempt(input));
    }

    private async redeemInviteAttempt(input: RedeemInput): Promise<RedeemResult> {
        const normalized = normalizeInviteCode(input.code);
        if (!normalized) {
            throw new ProtocolError('invite_unknown', 'that invite code is not well formed');
        }
        const digest = await hashCredential(normalized);
        const invite = await this.store.inviteByDigest(digest);
        if (!invite) {
            throw new ProtocolError('invite_unknown', 'that invite code is not valid');
        }
        const now = this.now();
        let view = await this.view(invite.roomId);
        assertRoomJoinable(view, now);
        let expectedOccupantId: string | null = null;
        const credentialHash = await hashCredential(input.participantCredential);
        if (invite.boundAttemptId === input.attemptId && invite.boundCredentialHash !== credentialHash) {
            throw new ProtocolError('unauthorized', 'this join attempt belongs to another participant');
        }

        if (invite.state === 'redeemed') {
            // The same attempt retrying gets its original membership back.
            if (invite.boundAttemptId === input.attemptId) {
                const actor = authenticate(view, credentialHash, now);
                if (invite.boundCredentialHash !== credentialHash || actor.kind !== 'participant' || actor.participant.participantId !== invite.redeemedParticipantId) {
                    throw new ProtocolError('unauthorized', 'this join attempt belongs to another participant');
                }
                assertActiveMember(actor);
                return {roomId: invite.roomId, participantId: invite.redeemedParticipantId!, role: actor.participant.role, replayed: true, snapshot: this.snapshotOf(view)};
            }
            if (!invite.reusable) {
                throw new ProtocolError('invite_already_redeemed', 'that invite code was already used');
            }
            // A reusable code is a seat. It reopens when its occupant leaves, but a
            // revoked participant's seat stays shut: removal is a deliberate act and
            // must not be undone by reusing the code that let them in.
            const occupant = invite.redeemedParticipantId
                ? (await this.view(invite.roomId)).participants.find((participant) => participant.participantId === invite.redeemedParticipantId)
                : undefined;
            if (occupant && occupant.revokedAt !== null) {
                throw new ProtocolError('invite_already_redeemed', 'that invite code belongs to a participant who was removed from the room');
            }
            if (occupant && occupant.leftAt === null) {
                throw new ProtocolError('invite_already_redeemed', `${occupant.displayName} is currently in the room using that code`);
            }
            expectedOccupantId = invite.redeemedParticipantId;
        } else if (invite.expiresAt !== null && now >= invite.expiresAt) {
            throw new ProtocolError('invite_expired', 'that invite code has expired');
        }

        // Codes from before the room became personal, or from a member, admit nobody now.
        if (roomType(view.room.policy) === 'personal' && invite.issuedBy !== 'owner' && invite.issuedBy !== 'admin') {
            throw new ProtocolError('unauthorized', 'this is a personal room: only codes from its owner admit anyone');
        }
        // The owner and admins choose who they give a code to; a member's code admits only someone who sees the room.
        if (invite.issuedBy === 'member' && !(await this.sees(view.room, input.member))) {
            throw new ProtocolError('unauthorized', NOT_VISIBLE);
        }
        const reserved = await this.store.reserveInvite(digest, input.attemptId, credentialHash, expectedOccupantId, view.room.stateRevision ?? 0);
        if (!reserved) {
            throw new ProtocolError('invite_already_redeemed', 'that invite code is being redeemed by another attempt');
        }
        // Reservation is a separate durable stage. Recheck admission against the revision it left.
        view = await this.view(invite.roomId);
        assertRoomJoinable(view, this.now());
        if (roomType(view.room.policy) === 'personal' && reserved.issuedBy !== 'owner' && reserved.issuedBy !== 'admin') {
            throw new ProtocolError('unauthorized', 'this is a personal room: only codes from its owner admit anyone');
        }
        if (reserved.issuedBy === 'member' && !(await this.sees(view.room, input.member))) {
            throw new ProtocolError('unauthorized', NOT_VISIBLE);
        }

        // Recovery path: the previous attempt created membership but lost its response.
        const existing = await this.store.participantByCredential(invite.roomId, credentialHash);
        if (existing) {
            assertActiveMember(authenticate(await this.view(invite.roomId), credentialHash, now));
            await this.store.completeInvite(digest, existing.participantId, input.attemptId);
            return {roomId: invite.roomId, participantId: existing.participantId, role: existing.role, replayed: true, snapshot: this.snapshotOf(await this.view(invite.roomId))};
        }

        const previousOccupant = view.participants.find((participant) => participant.participantId === invite.redeemedParticipantId);
        // A demoted admin must not regain privileges through the old invite seat.
        const admissionRole = reserved.role === 'controller' && previousOccupant && previousOccupant.role !== 'controller' ? 'member' : reserved.role;
        const joined = joinRoom(
            view,
            {
                role: admissionRole,
                credentialHash,
                displayName: input.useInviteName !== false ? reserved.defaultName ?? input.displayName : input.displayName,
                kind: input.kind,
                nameSource: input.nameSource,
                sessionId: input.sessionId ?? null,
                capabilities: input.capabilities ?? null,
                ...(input.member ? {member: input.member} : {}),
                ...(reserved.origin ? {origin: reserved.origin} : {})
            },
            this.ctx()
        );
        if (previousOccupant?.muted) {
            joined.participant.muted = true;
        }
        // Leaving and coming back on the same seat keeps what was refused; what was allowed must be granted again.
        const refused = refusedPermissions(previousOccupant?.permissions);
        if (refused && admissionRole === 'member') {
            joined.participant.permissions = refused;
        }
        await this.store.apply(joined.mutation, null);
        await this.store.completeInvite(digest, joined.participant.participantId, input.attemptId);
        return {roomId: invite.roomId, participantId: joined.participant.participantId, role: admissionRole, replayed: false, snapshot: this.snapshotOf(await this.view(invite.roomId))};
    }

    async send(roomId: string, credential: string, request: SendEventRequest): Promise<SentEventResult> {
        return retryRoomConflict(() => this.sendAttempt(roomId, credential, request));
    }

    private async sendAttempt(roomId: string, credential: string, request: SendEventRequest): Promise<SentEventResult> {
        const view = await this.view(roomId, request.type.startsWith('handover.'));
        // One clock reading for the whole operation: the request record and the event it
        // produces must carry the same time, or a client comparing them sees one as stale.
        const now = this.now();
        const actor = authenticate(view, await hashCredential(credential), now);
        const participantId = actor.kind === 'participant' ? actor.participant.participantId : undefined;
        const group = request.recipientIds !== undefined || request.allRecipients === true;
        if (group && (request.type !== 'message' || request.replyTo || request.recipientId || (request.recipientIds && request.allRecipients))) {
            throw new ProtocolError('invalid_request', 'group recipients are only valid for a new message; choose names or all');
        }
        if (request.type === 'message.received') {
            const participant = assertCanAcknowledge(actor);
            const target = await this.turns.resolve(roomId, request.payload.eventId, participant.participantId);
            const eventId = target?.conversationId ?? request.payload.eventId;
            request = {...request, payload: {...request.payload, eventId}, ...(!request.payload.action ? {idempotencyKey: `${request.payload.stage === 'read' ? 'read' : 'receipt'}-${eventId}-${participant.participantId}`} : {})};
            if (this.receiptMode === 'watermark' && isPlainReceipt(request)) {
                // An older client's plain receipt: kept as the watermark, answered as an event that already existed.
                assertRoomWritable(view, now);
                await this.plainReceipt(view, participant, eventId, now);
                const event = {protocolVersion: PROTOCOL_VERSION, roomId, seq: Math.max(1, view.room.nextSeq - 1), eventId: newId('event'), senderId: participant.participantId, idempotencyKey: request.idempotencyKey, recipientId: null, replyTo: null, at: now, type: 'message.received', payload: request.payload} as RoomEvent;
                return {event, deduplicated: true};
            }
        }
        const requestDigest = stableStringify({type: request.type, payload: request.payload, recipientId: request.recipientId ?? null, replyTo: request.replyTo ?? null,
            ...(request.recipientIds ? {recipientIds: request.recipientIds} : {}), ...(request.allRecipients ? {allRecipients: true} : {}), ...(request.quoteOf ? {quoteOf: request.quoteOf} : {})});
        const previous = await this.store.idempotencyRecord(roomId, request.idempotencyKey);
        if (previous) {
            if (previous.requestDigest !== requestDigest) {
                throw new ProtocolError('idempotency_conflict', 'this idempotency key was used with different content');
            }
            const event = await this.store.eventBySeq(roomId, previous.seq);
            if (!event) {
                throw new ProtocolError('cursor_gap', 'the original event for this idempotency key is no longer retained');
            }
            return {event, deduplicated: true};
        }
        let quoteContext = '';
        if (request.quoteOf) {
            if (request.type !== 'message' || request.replyTo) {
                throw new ProtocolError('invalid_request', 'quoteOf is only valid on a new message, without replyTo');
            }
            const original = await this.store.eventById(roomId, request.quoteOf);
            if (original?.type !== 'message') {
                throw new ProtocolError('invalid_request', 'the quoted message is no longer retained in this room');
            }
            const sender = view.participants.find((participant) => participant.participantId === original.senderId)?.displayName ?? original.senderId;
            const excerpt = original.payload.text.slice(0, 4000);
            quoteContext = `Quoted message from ${sender}:\n${excerpt}${excerpt.length < original.payload.text.length ? '\n[quote shortened]' : ''}\n\nFollow-up:\n`;
        }
        // A new attempt at a failed request, for the same recipient or another. The failed
        // attempt is kept as it is; only its asker or an admin may ask again.
        let recovered: MessageRequest | null = null;
        if (request.type === 'message' && request.payload.recovers) {
            if (group || request.replyTo || !request.recipientId) {
                throw new ProtocolError('invalid_request', 'a recovery is a new message to one participant');
            }
            recovered = await this.store.messageRequest(roomId, request.payload.recovers);
            if (!recovered) {
                throw new ProtocolError('invalid_request', 'no such request in this room');
            }
            if (actor.kind !== 'participant' || (participantId !== recovered.from && actor.participant.role !== 'controller')) {
                throw new ProtocolError('unauthorized', 'only the original sender or a room admin may retry a request');
            }
            if (recovered.responseEventId || (!recovered.requiresReply && recovered.resolution !== 'cancelled')) {
                throw new ProtocolError('invalid_request', 'this request is already resolved');
            }
            if (!recovered.failureAt && !recovered.providerWait) {
                throw new ProtocolError('invalid_request', 'this request has not failed or entered provider wait; wait for it or cancel it');
            }
            if (recovered.recoveredByEventId) {
                throw new ProtocolError('invalid_request', `this attempt is already being recovered as ${recovered.recoveredByEventId}; retry that one if it failed`);
            }
        }
        let recipients = request.recipientId ? [request.recipientId] : [];
        if (group) {
            const eligible = view.participants.filter((participant) => participant.kind === 'agent' && participant.role !== 'guest' && participant.leftAt === null && participant.revokedAt === null && !participant.muted && participant.participantId !== participantId).sort((a, b) => a.joinedAt - b.joinedAt || a.participantId.localeCompare(b.participantId));
            recipients = request.allRecipients ? eligible.map((participant) => participant.participantId) : [...new Set(request.recipientIds!)];
            if (!recipients.length || recipients.some((id) => !eligible.some((participant) => participant.participantId === id))) {
                throw new ProtocolError('invalid_request', 'address one or more active, unmuted agent members other than yourself');
            }
            if (request.allRecipients) {
                const start = (view.room.allStartIndex ?? 0) % recipients.length;
                recipients = [...recipients.slice(start), ...recipients.slice(0, start)];
            }
        }
        const updates: MessageRequest[] = [];
        let replyTarget: MessageRequest | null = null;
        // A plain receipt for a message not addressed to this participant also moves their watermark, in `both`.
        let watermarkSeq: number | null = null;
        if (request.type === 'message.received') {
            const participant = assertCanAcknowledge(actor);
            const target = await this.turns.resolve(roomId, request.payload.eventId, participant.participantId);
            const original = target ? null : await this.store.eventById(roomId, request.payload.eventId);
            if (!target && original?.type !== 'message') {
                throw new ProtocolError('invalid_request', 'no such retained message in this room');
            }
            if ((target?.from ?? original?.senderId) === participant.participantId) {
                throw new ProtocolError('unauthorized', 'a sender cannot acknowledge their own message');
            }
            if (this.receiptMode === 'both' && isPlainReceipt(request) && target?.to !== participant.participantId) {
                watermarkSeq = original?.seq ?? (await this.messageSeqOf(roomId, target!));
            }
            if (target?.to === participant.participantId) {
                updates.push({...target, receivedAt: target.receivedAt ?? now, ...(request.payload.stage === 'read' ? {readAt: target.readAt ?? now} : {})});
            }
            const action = request.payload.action;
            if (action) {
                if (request.payload.responseEventId && action !== 'done') {
                    throw new ProtocolError('invalid_request', 'A linked answer requires the done action.');
                }
                if (action !== 'reply_pending' && request.payload.stage !== 'read') {
                    throw new ProtocolError('invalid_request', 'Declare reading before a model action.');
                }
                if (['waiting', 'no_action', 'declined'].includes(action) && !request.payload.reason?.trim()) {
                    throw new ProtocolError('invalid_request', 'This action needs a reason.');
                }
                if (target?.to === participant.participantId && !target.requiresReply && target.action === action && target.actionReason === request.payload.reason && ['no_action', 'declined'].includes(action)) {
                    updates[0] = {...target, readAt: target.readAt ?? now};
                } else if (target?.to === participant.participantId && (target.requiresReply || target.responseEventId || target.action || target.turnRequired)) {
                    assertCanWrite(actor);
                    if (target.responseEventId || !target.requiresReply) {
                        throw new ProtocolError('invalid_request', 'This request is already resolved.');
                    }
                    if (action === 'done') {
                        const answer = request.payload.responseEventId ? await this.store.eventById(roomId, request.payload.responseEventId) : null;
                        const origin = await this.store.eventById(roomId, target.conversationId ?? target.eventId);
                        if (answer?.type !== 'message' || answer.senderId !== participant.participantId || (origin ? answer.seq <= origin.seq : answer.at < target.at) || answer.replyTo || answer.recipientIds || (answer.recipientId !== null && answer.recipientId !== target.from) || answer.payload.responseStage === 'progress') {
                            throw new ProtocolError('invalid_request', 'Link an existing unthreaded answer authored by this recipient after the request.');
                        }
                        if (target.turnRequired && !target.failureAt) {
                            assertTurn(target, request.turnToken, now);
                        }
                        if (['cancelled', 'skipped', 'passed'].includes(target.turnStatus ?? '')) {
                            throw new ProtocolError('invalid_request', 'A cancelled or skipped request cannot be completed by a late answer.');
                        }
                        updates[0] = {...updates[0]!, responseEventId: answer.eventId, responseText: answer.payload.text, respondedAt: now, action, actionAt: now, ...(target.turnRequired ? {turnStatus: 'answered'} : {})};
                        // Reclassify the standalone answer: it must not leave a reverse
                        // "please reply" obligation on the original asker.
                        const reverse = await this.store.messageRequest(roomId, answer.eventId);
                        if (reverse && !reverse.responseEventId) {
                            updates.push({...reverse, requiresReply: false, ...(reverse.turnRequired ? {turnStatus: 'cancelled', turnToken: '', turnExpiresAt: 0} : {})});
                        }
                    } else {
                        if (target.failureAt) {
                            throw new ProtocolError('invalid_request', 'This attempt failed. Link a completed answer explicitly instead of restarting it through status.');
                        }
                        assertTurn(target, request.turnToken, now);
                        const terminal = action === 'no_action' || action === 'declined';
                        updates[0] = {...updates[0]!, action, actionAt: now, actionReason: request.payload.reason ?? '', ...(terminal ? {requiresReply: false, ...(target.turnRequired ? {turnStatus: 'passed'} : {})} : {})};
                    }
                } else if (action !== 'no_action') {
                    throw new ProtocolError('unauthorized', 'Only the addressed recipient may change the action for this request.');
                } else if (target?.to === participant.participantId) {
                    updates[0] = {...updates[0]!, action, actionAt: now, actionReason: request.payload.reason!};
                }
            } else if (request.payload.responseEventId) {
                throw new ProtocolError('invalid_request', 'A linked answer requires the done action.');
            }
        } else if (request.type === 'message.delivery_failed' || (request.type === 'message' && request.replyTo)) {
            const id = request.type === 'message.delivery_failed' ? request.payload.eventId : request.replyTo!;
            const target = await this.turns.resolve(roomId, id, participantId);
            if (!target) {
                throw new ProtocolError('invalid_request', 'no such addressed message in this room');
            }
            if (participantId !== target.to) {
                throw new ProtocolError('unauthorized', 'only the addressed recipient may answer this message');
            }
            assertTurn(target, request.turnToken, now);
            if (request.type === 'message.delivery_failed') {
                if (target.responseEventId || !target.requiresReply) {
                    throw new ProtocolError('invalid_request', 'this request is already finished');
                }
                updates.push({...target, failureAt: now, failureReason: request.payload.reason, ...(request.payload.stage ? {failureStage: request.payload.stage} : {}), ...(target.turnRequired ? {turnStatus: 'failed' as const} : {})});
            } else {
                if (request.recipientId !== target.from) {
                    throw new ProtocolError('invalid_request', 'a reply must be addressed to the original sender');
                }
                if (!target.requiresReply || target.responseEventId) {
                    throw new ProtocolError('invalid_request', 'this request is already finished or is itself a reply');
                }
                if (target.receivedAt === null) {
                    throw new ProtocolError('invalid_request', 'acknowledge the request before replying');
                }
                replyTarget = target;
                updates.push({...target, progressAt: request.payload.responseStage === 'progress' ? now : target.progressAt});
            }
        } else if (request.type === 'message' && request.payload.responseStage) {
            throw new ProtocolError('invalid_request', 'responseStage requires replyTo');
        }
        if (request.type === 'message' && recipients.length && !request.replyTo) {
            if ((await this.store.pendingRequestCount(roomId)) + recipients.length > 1000) {
                throw new ProtocolError('quota_exceeded', 'answer or resolve pending requests before creating more');
            }
        }
        let attached: string[] = [];
        if (request.type === 'message' && request.payload.attachments) {
            const carried = await this.attachments(view, actor, request.payload.attachments);
            request = {...request, payload: {...request.payload, attachments: carried}};
            attached = carried.map((file) => file.fileId);
        }
        const outgoing = replyTarget?.conversationId ? {...request, replyTo: replyTarget.conversationId} : request;
        const mutation = sendEvent(view, await hashCredential(credential), outgoing, {now, newEventId: () => newId('event')});
        if (watermarkSeq !== null && participantId) {
            mutation.room = withReceipt(mutation.room, participantId, watermarkSeq, now);
        }
        if (attached.length) {
            mutation.attachFiles = attached;
        }
        if (group) {
            mutation.appendEvent.recipientIds = recipients;
            mutation.appendEvent.allRecipients = request.allRecipients === true;
            if (request.allRecipients) {
                mutation.room.allStartIndex = (view.room.allStartIndex ?? 0) + 1;
            }
        }
        if (replyTarget && request.type === 'message' && request.payload.responseStage !== 'progress') {
            updates[0] = {...replyTarget, responseEventId: mutation.appendEvent.eventId, respondedAt: now, responseText: request.payload.text, action: 'done', actionAt: now, ...(replyTarget.turnRequired ? {turnStatus: 'answered' as const} : {})};
            // The answer to a recovery also resolves every failed attempt before it. Their failures stay on record.
            let earlier = replyTarget.recoversEventId;
            for (let depth = 0; earlier && depth < 32; depth++) {
                const failed = await this.store.messageRequest(roomId, earlier);
                if (!failed || failed.responseEventId) {
                    break;
                }
                updates.push({...failed, responseEventId: mutation.appendEvent.eventId, respondedAt: now, responseText: request.payload.text, action: 'done', actionAt: now});
                earlier = failed.recoversEventId;
            }
        }
        if (updates.some((entry) => entry.turnRequired) && (request.type !== 'message.received' || request.payload.action)) {
            const revision = view.room.turnRevision ?? 0;
            mutation.expectedTurnRevision = revision;
            mutation.room.turnRevision = revision + 1;
            mutation.room.turnChangedAt = now;
            for (const entry of updates) {
                entry.turnRevision = revision + 1;
            }
        }
        if (request.type === 'message' && recipients.length) {
            const senderOrigin = findParticipant(view, mutation.appendEvent.senderId!)?.origin;
            let seq = Math.max(view.room.nextRequestSeq ?? 0, mutation.appendEvent.seq);
            for (const recipient of recipients) {
                updates.push({
                    roomId, eventId: group ? newId('event') : mutation.appendEvent.eventId, seq: seq++, messageSeq: mutation.appendEvent.seq,
                    from: mutation.appendEvent.senderId!, to: recipient, text: quoteContext + request.payload.text, at: mutation.appendEvent.at,
                    requiresReply: !request.replyTo, receivedAt: null, responseEventId: null, respondedAt: null, progressAt: null,
                    ...(group ? {conversationId: mutation.appendEvent.eventId, turnRequired: true} : {}),
                    ...(recovered ? {recoversEventId: recovered.eventId, attempt: (recovered.attempt ?? 1) + 1} : {}),
                    ...(request.payload.attachments ? {attachments: request.payload.attachments} : {}),
                    ...(senderOrigin ? {origin: senderOrigin} : {})
                });
            }
            mutation.room.nextRequestSeq = seq;
        }
        if (recovered) {
            updates.push({...recovered, recoveredByEventId: mutation.appendEvent.eventId});
        }
        mutation.upsertRequests = updates;
        await this.store.apply(mutation, {key: request.idempotencyKey, requestDigest});
        return {event: mutation.appendEvent, deduplicated: false};
    }

    async acknowledgeMessage(roomId: string, credential: string, eventId: string): Promise<MessageRequest | null> {
        return retryRoomConflict(async () => {
            const view = await this.view(roomId);
            const now = this.now();
            const actor = authenticate(view, await hashCredential(credential), now);
            const participant = assertCanAcknowledge(actor);
            const target = await this.turns.resolve(roomId, eventId, participant.participantId);
            if (target?.to === participant.participantId && target.receivedAt !== null) {
                return this.publicRequest(target);
            }
            if (this.receiptMode === 'watermark') {
                assertRoomWritable(view, now);
                await this.plainReceipt(view, participant, eventId, now);
                const received = await this.turns.resolve(roomId, eventId, participant.participantId);
                return received ? this.publicRequest(received) : null;
            }
            const root = target?.conversationId ?? eventId;
            const key = `receipt-${root}-${participant.participantId}`;
            const saved = await this.store.idempotencyRecord(roomId, key);
            const digest = stableStringify({type: 'message.received', payload: {eventId: root}, recipientId: null, replyTo: null});
            if (saved && saved.requestDigest !== digest) {
                throw new ProtocolError('idempotency_conflict', 'the receipt key was used with different content');
            }
            if (!saved) {
                await this.send(roomId, credential, {type: 'message.received', payload: {eventId: root}, idempotencyKey: key});
            }
            const updated = await this.turns.resolve(roomId, eventId, participant.participantId);
            return updated ? this.publicRequest(updated) : null;
        });
    }

    /**
     * `POST /v1/rooms/:id/receipts`: this participant has received every event up to `throughSeq`.
     * Moves their watermark and marks their requests up to there received, with no event.
     */
    async receipt(roomId: string, credential: string, throughSeq: number): Promise<ReceiptResponse> {
        return retryRoomConflict(() => this.receiptAttempt(roomId, credential, throughSeq));
    }

    private async receiptAttempt(roomId: string, credential: string, throughSeq: number): Promise<ReceiptResponse> {
        if (this.receiptMode === 'events') {
            throw new ProtocolError('unsupported_capability', 'this relay keeps receipts as events; acknowledge each message instead');
        }
        const view = await this.view(roomId);
        const now = this.now();
        const participant = assertCanAcknowledge(authenticate(view, await hashCredential(credential), now));
        assertRoomWritable(view, now);
        const room = await this.moveWatermark(view, participant.participantId, throughSeq, now);
        return {throughSeq: room.receipts?.[participant.participantId]?.throughSeq ?? 0, receiptRevision: room.receiptRevision ?? 0};
    }

    /** A plain receipt with no event: the request it answers when it is addressed to this participant, else their watermark. */
    private async plainReceipt(view: RoomView, participant: ParticipantRecord, eventId: string, now: number): Promise<void> {
        const roomId = view.room.roomId;
        const target = await this.turns.resolve(roomId, eventId, participant.participantId);
        const original = target ? null : await this.store.eventById(roomId, eventId);
        if (!target && original?.type !== 'message') {
            throw new ProtocolError('invalid_request', 'no such retained message in this room');
        }
        if ((target?.from ?? original?.senderId) === participant.participantId) {
            throw new ProtocolError('unauthorized', 'a sender cannot acknowledge their own message');
        }
        if (target?.to === participant.participantId) {
            // A receiver may confirm one request out of order, so it says nothing about earlier messages.
            if (target.receivedAt === null) {
                await this.store.updateTurns(view.room, [{...target, receivedAt: now}], view.room.turnRevision ?? 0);
            }
            return;
        }
        // Everything else is confirmed by a reader going through the room in order.
        await this.moveWatermark(view, participant.participantId, original?.seq ?? (await this.messageSeqOf(roomId, target!)), now);
    }

    /** Writes the moved watermark and the requests it marks received, in one write without an event. */
    private async moveWatermark(view: RoomView, participantId: string, throughSeq: number, now: number): Promise<RoomRecord> {
        const room = withReceipt(view.room, participantId, throughSeq, now);
        if (room === view.room) {
            return room;
        }
        // The store records a compact timestamped range atomically with this mark. Request reads
        // project their first receipt from it, including completed replies and arbitrarily old backlogs.
        await this.store.updateTurns(room, [], view.room.turnRevision ?? 0);
        return room;
    }

    /** The transcript seq of a request's message; 0 when that message is no longer retained, which puts it behind any watermark. */
    private async messageSeqOf(roomId: string, request: MessageRequest): Promise<number> {
        return request.messageSeq ?? (await this.store.eventById(roomId, request.conversationId ?? request.eventId))?.seq ?? 0;
    }

    private publicRequest(request: MessageRequest): MessageRequest {
        const result = {...request};
        delete result.turnToken;
        delete result.turnClaimId;
        return result;
    }

    async requests(roomId: string, credential: string, after = 0, limit = 100, recipientId?: string, supportsTurns = true): Promise<RequestPage> {
        await this.reader(roomId, credential);
        if (supportsTurns) {
            const page = await this.store.messageRequests(roomId, after, limit, recipientId);
            return {...page, requests: page.requests.map((request) => this.publicRequest(request))};
        }
        // Old receivers must not start guarded work, nor get an empty page with
        // hasMore=true that gives their cursor no way to advance.
        let cursor = after;
        const visible: MessageRequest[] = [];
        for (let pageNumber = 0; pageNumber < 1101; pageNumber++) {
            const page = await this.store.messageRequests(roomId, cursor, Math.max(limit, 100), recipientId);
            visible.push(...page.requests.filter((request) => !request.turnRequired));
            if (visible.length >= limit || !page.hasMore) {
                return {requests: visible.slice(0, limit).map((request) => this.publicRequest(request)), hasMore: visible.length > limit || page.hasMore};
            }
            const next = page.requests.at(-1)?.seq;
            if (next === undefined || next <= cursor) {
                throw new ProtocolError('server_unavailable', 'request pagination did not advance');
            }
            cursor = next;
        }
        throw new ProtocolError('server_unavailable', 'pending request limit exceeded');
    }

    async request(roomId: string, credential: string, eventId: string): Promise<MessageRequest> {
        const {actor} = await this.reader(roomId, credential);
        const request = await this.turns.resolve(roomId, eventId, actor.kind === 'participant' ? actor.participant.participantId : undefined);
        if (!request) {
            throw new ProtocolError('invalid_request', 'no such addressed delivery; use a recipient delivery ID for a group message');
        }
        return this.publicRequest(request);
    }

    /** Archives a failed request or fences unresolved work without ever claiming success. */
    async resolveRequest(roomId: string, credential: string, eventId: string, input: ResolveRequestRequest): Promise<RequestResolutionResult> {
        const outcome = input.action === 'dismiss' ? 'dismissed' : 'cancelled';
        const key = `request-${outcome}-${eventId}`;
        const requestDigest = stableStringify({eventId, outcome, reason: input.reason ?? null});
        for (let attempt = 0; attempt < 4; attempt++) {
            const view = await this.view(roomId);
            const now = this.now();
            const actor = authenticate(view, await hashCredential(credential), now);
            assertRoomWritable(view, now);
            const target = await this.store.messageRequest(roomId, eventId);
            if (!target) {
                throw new ProtocolError('invalid_request', 'no such addressed delivery; use a recipient delivery ID for a group message');
            }
            if (actor.kind === 'participant' && actor.participant.participantId !== target.from && actor.participant.role !== 'controller') {
                throw new ProtocolError('unauthorized', 'only the original sender or a room admin may dismiss or cancel a request');
            }
            if (target.resolution) {
                if (target.resolution !== outcome) {
                    throw new ProtocolError('invalid_request', `this request was already ${target.resolution}`);
                }
                if ((target.resolutionReason ?? '') !== (input.reason ?? '')) {
                    throw new ProtocolError('idempotency_conflict', 'this request resolution was already recorded with a different reason');
                }
                const event = target.resolutionEventId ? await this.store.eventById(roomId, target.resolutionEventId) : null;
                if (!event) {
                    throw new ProtocolError('cursor_gap', 'the request resolution event is no longer retained');
                }
                return {event, request: this.publicRequest(target), deduplicated: true};
            }
            if (target.responseEventId || !target.requiresReply) {
                throw new ProtocolError('invalid_request', 'this request is already resolved');
            }
            if (target.recoveredByEventId) {
                throw new ProtocolError('invalid_request', `this request is being recovered as ${target.recoveredByEventId}; resolve that current attempt instead`);
            }
            if (outcome === 'dismissed' && !target.failureAt) {
                throw new ProtocolError('invalid_request', 'only a failed request can be dismissed; cancel unresolved work instead');
            }
            const saved = await this.store.idempotencyRecord(roomId, key);
            if (saved) {
                if (saved.requestDigest !== requestDigest) {
                    throw new ProtocolError('idempotency_conflict', 'this request resolution was already recorded with a different reason');
                }
                const event = await this.store.eventBySeq(roomId, saved.seq);
                const current = await this.store.messageRequest(roomId, eventId);
                if (!event || !current) {
                    throw new ProtocolError('cursor_gap', 'the request resolution is no longer retained');
                }
                return {event, request: this.publicRequest(current), deduplicated: true};
            }
            const senderId = actor.kind === 'participant' ? actor.participant.participantId : null;
            const {room: appendedRoom, event} = appendEvent(view.room, {
                senderId,
                idempotencyKey: key,
                recipientId: target.to,
                replyTo: null,
                body: {type: 'message.request_closed', payload: {eventId: target.eventId, outcome, ...(input.reason ? {reason: input.reason} : {})}}
            }, {now, newEventId: () => newId('event')});
            const resolutionBy = senderId ?? 'controller';
            const updated: MessageRequest = {
                ...target,
                requiresReply: false,
                resolution: outcome,
                resolutionAt: now,
                resolutionBy,
                resolutionReason: input.reason ?? '',
                resolutionEventId: event.eventId,
                ...(outcome === 'cancelled' && !target.failureAt ? {failureAt: now, failureReason: input.reason ?? 'Cancelled by the sender or a room admin.'} : {}),
                ...(target.turnRequired ? {turnStatus: 'cancelled' as const, turnToken: '', turnExpiresAt: 0} : {})
            };
            const revision = view.room.turnRevision ?? 0;
            const room = target.turnRequired ? {...appendedRoom, turnRevision: revision + 1, turnChangedAt: now} : appendedRoom;
            if (target.turnRequired) {
                updated.turnRevision = revision + 1;
            }
            try {
                await this.store.apply({...emptyMutation(room, event), ...(target.turnRequired ? {expectedTurnRevision: revision} : {}), upsertRequests: [updated]}, {key, requestDigest});
                return {event, request: this.publicRequest(updated), deduplicated: false};
            } catch (error) {
                if (!(error instanceof ProtocolError) || !['server_unavailable', 'turn_conflict'].includes(error.code) || attempt === 3) {
                    throw error;
                }
            }
        }
        throw new ProtocolError('server_unavailable', 'request resolution could not be committed');
    }

    async setLocked(roomId: string, credential: string, locked: boolean): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(setLocked(await this.view(roomId), await hashCredential(credential), locked, this.ctx()));
        });
    }

    async setMuted(roomId: string, credential: string, participantId: string, muted: boolean): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(setMuted(await this.view(roomId), await hashCredential(credential), participantId, muted, this.ctx()));
        });
    }

    async setRole(roomId: string, credential: string, participantId: string, role: 'member' | 'controller'): Promise<RoomSnapshot> {
        return retryRoomConflict(async () => {
            const mutation = setParticipantRole(await this.view(roomId), await hashCredential(credential), participantId, role, this.ctx());
            if (mutation) {
                await this.applyOne(mutation);
            }
            return this.snapshotOf(await this.view(roomId));
        });
    }

    async setRoomPermissions(roomId: string, credential: string, change: PermissionChange): Promise<RoomSnapshot> {
        return retryRoomConflict(async () => {
            const mutation = setRoomPermissions(await this.view(roomId), await hashCredential(credential), change, this.ctx());
            if (mutation) {
                await this.applyOne(mutation);
            }
            return this.snapshotOf(await this.view(roomId));
        });
    }

    async setParticipantPermissions(roomId: string, credential: string, participantId: string, change: PermissionChange): Promise<RoomSnapshot> {
        return retryRoomConflict(async () => {
            const mutation = setParticipantPermissions(await this.view(roomId), await hashCredential(credential), participantId, change, this.ctx());
            if (mutation) {
                await this.applyOne(mutation);
            }
            return this.snapshotOf(await this.view(roomId));
        });
    }

    async control(roomId: string, credential: string, targetParticipantId: string, paused: boolean): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(requestControl(await this.view(roomId), await hashCredential(credential), targetParticipantId, paused, this.ctx()));
        });
    }

    /**
     * Stops one agent: holds its later work like a pause, then fences the turn it is
     * running so a late answer cannot be posted. Its receiver acknowledges what it could
     * actually stop. Other agents and the rest of a group round are not affected.
     */
    async interrupt(roomId: string, credential: string, targetParticipantId: string): Promise<InterruptResult> {
        const event = await retryRoomConflict(async () => this.applyOne(requestControl(await this.view(roomId), await hashCredential(credential), targetParticipantId, true, this.ctx(), true)));
        const fenced = await this.turns.fenceRunning(roomId, credential, targetParticipantId);
        return {event, fenced};
    }

    async revoke(roomId: string, credential: string, targetParticipantId: string): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(revokeParticipant(await this.view(roomId), await hashCredential(credential), targetParticipantId, this.ctx()));
        });
    }

    async leave(roomId: string, credential: string): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(leaveRoom(await this.view(roomId), await hashCredential(credential), this.ctx()));
        });
    }

    async rejoin(roomId: string, credential: string): Promise<RoomSnapshot> {
        return retryRoomConflict(async () => {
            const view = await this.view(roomId);
            const hash = await hashCredential(credential);
            const actor = authenticate(view, hash, this.now());
            if (actor.kind !== 'participant') {
                throw new ProtocolError('unauthorized', 'rejoining requires the saved participant credential');
            }
            if (actor.participant.leftAt === null) {
                return this.snapshotOf(view);
            }
            await this.applyOne(rejoinRoom(view, hash, this.ctx()));
            return this.snapshot(roomId, credential);
        });
    }

    async renameSelf(roomId: string, credential: string, input: RenameSelfRequest): Promise<RoomSnapshot> {
        return retryRoomConflict(async () => {
            const mutation = renameSelf(await this.view(roomId), await hashCredential(credential), input, this.ctx());
            if (mutation) {
                await this.applyOne(mutation);
            }
            return this.snapshot(roomId, credential);
        });
    }

    async rename(roomId: string, credential: string, name: string): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(renameRoom(await this.view(roomId), await hashCredential(credential), name, this.ctx()));
        });
    }

    async setJoinPolicy(roomId: string, credential: string, joinPolicy: 'invite_only' | 'open_to_guests'): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(setJoinPolicy(await this.view(roomId), await hashCredential(credential), joinPolicy, this.ctx()));
        });
    }

    async setInviteRole(roomId: string, credential: string, inviteRole: 'member' | 'guest'): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(setInviteRole(await this.view(roomId), await hashCredential(credential), inviteRole, this.ctx()));
        });
    }

    async setLocalJoin(roomId: string, credential: string, localJoin: boolean): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(setLocalJoin(await this.view(roomId), await hashCredential(credential), localJoin, this.ctx()));
        });
    }

    async setRoomType(roomId: string, credential: string, type: RoomType): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(setRoomType(await this.view(roomId), await hashCredential(credential), type, this.ctx()));
        });
    }

    /** Sets who sees the room; null when it already was. Owner or admin, on a room with an owner. */
    async setVisibility(roomId: string, credential: string, visibility: RoomVisibility): Promise<RoomEvent | null> {
        return retryRoomConflict(async () => {
            const mutation = setRoomVisibility(await this.view(roomId), await hashCredential(credential), visibility, this.ctx());
            return mutation ? this.applyOne(mutation) : null;
        });
    }

    /** Whether the member with this handle sees the room, after its owner's default. */
    async sees(room: RoomRecord, handle: string | null | undefined): Promise<boolean> {
        return canSee(room, room.owner ? await this.memberDefault(room.owner) : null, handle);
    }

    /** Adds "invited @handle" or "withdrew the invitation" to the transcript. For relays that hold accounts; there is no HTTP route for it. */
    async recordInvitation(roomId: string, credential: string, change: RoomInvitationChange): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(recordInvitation(await this.view(roomId), await hashCredential(credential), change, this.ctx()));
        });
    }

    /** Guest entry. Knowing the room id is the entire claim, so the room must allow it. */
    async joinAsGuest(roomId: string, input: GuestJoinInput): Promise<RedeemResult> {
        return this.joinWithoutInvite(roomId, input, joinAsGuest);
    }

    /** A trusted account layer has already authorized this identity and role; ordinary room admission and retry rules still apply. */
    async joinAuthorized(roomId: string, input: GuestJoinInput, role: ParticipantRole): Promise<RedeemResult> {
        return this.joinWithoutInvite(roomId, input, (view, identity, context) => joinRoom(view, {...identity, role}, context));
    }

    /**
     * Member entry by name from the relay's local network or tailnet. Only call this
     * once the transport has established where the request came from; the room
     * itself must also allow it.
     */
    async joinOnLocalNetwork(roomId: string, input: GuestJoinInput): Promise<RedeemResult> {
        const view = await this.view(roomId);
        if (!(await this.sees(view.room, input.member))) {
            throw new ProtocolError('unauthorized', NOT_VISIBLE);
        }
        return this.joinWithoutInvite(roomId, input, joinOnLocalNetwork);
    }

    /** A retry with the same credential gets its original membership back instead of a second one. */
    private async joinWithoutInvite(roomId: string, input: GuestJoinInput, admit: typeof joinAsGuest): Promise<RedeemResult> {
        return retryRoomConflict(async () => {
            const view = await this.view(roomId);
            assertRoomJoinable(view, this.now());
            const credentialHash = await hashCredential(input.participantCredential);
            const existing = await this.store.participantByCredential(roomId, credentialHash);
            if (existing) {
                assertActiveMember(authenticate(view, credentialHash, this.now()));
                return {roomId, participantId: existing.participantId, role: existing.role, replayed: true, snapshot: this.snapshotOf(view)};
            }

            const joined = admit(
                view,
                {
                    credentialHash,
                    displayName: input.displayName,
                    kind: input.kind,
                    nameSource: input.nameSource,
                    sessionId: input.sessionId ?? null,
                    capabilities: input.capabilities ?? null,
                    ...(input.member ? {member: input.member} : {})
                },
                this.ctx()
            );
            await this.store.apply(joined.mutation, null);
            return {roomId, participantId: joined.participant.participantId, role: joined.participant.role, replayed: false, snapshot: this.snapshotOf(await this.view(roomId))};
        });
    }

    async setExpiry(roomId: string, credential: string, expiresAt: number | null): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(setExpiry(await this.view(roomId), await hashCredential(credential), expiresAt, this.ctx()));
        });
    }

    async setAutoClose(roomId: string, credential: string, autoClose: AutoClosePolicy): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            const event = await this.applyOne(setAutoClose(await this.view(roomId), await hashCredential(credential), autoClose, this.ctx()));
            // A policy that is already overdue closes the room now rather than at the next request.
            await this.store.loadRoom(roomId);
            return event;
        });
    }

    /**
     * Closes rooms whose deadline has passed, in a bounded batch. Returns how many
     * closed and the next deadline, so a scheduler can wake once, at the earliest.
     */
    async closeDueRooms(limit = 50): Promise<AutoCloseSweep> {
        const due = await this.store.dueAutoCloses(this.now(), limit);
        let closed = 0;
        for (const roomId of due) {
            if ((await this.store.loadRoom(roomId))?.room.lifecycle === 'closed') {
                closed++;
            }
        }
        return {closed, more: due.length === limit, nextAt: await this.store.nextAutoCloseAt(this.now())};
    }

    async close(roomId: string, credential: string): Promise<RoomEvent> {
        return retryRoomConflict(async () => {
            return this.applyOne(closeRoom(await this.view(roomId), await hashCredential(credential), this.ctx()));
        });
    }

    /** Owner or admin: refuses writes for a while so the room can be copied to another relay. Asking again renews the lease. */
    async prepareMove(roomId: string, credential: string): Promise<{until: number}> {
        const store = this.movableStore();
        const view = await this.view(roomId);
        const now = this.now();
        assertController(authenticate(view, await hashCredential(credential), now));
        assertRoomWritable(view, now);
        const until = now + MOVE_LEASE_MS;
        store.setMoveLease(roomId, until);
        return {until};
    }

    /** Owner or admin: the move did not happen, so the room takes writes again. */
    async abortMove(roomId: string, credential: string): Promise<void> {
        const store = this.movableStore();
        const view = await this.view(roomId);
        assertController(authenticate(view, await hashCredential(credential), this.now()));
        store.setMoveLease(roomId, null);
    }

    /** Owner or admin, while the lease holds: every row of the room, as NDJSON. */
    async moveTransfer(roomId: string, credential: string): Promise<Response> {
        const store = this.movableStore();
        const view = await this.view(roomId);
        const now = this.now();
        assertController(authenticate(view, await hashCredential(credential), now));
        if (store.moveLease(roomId, now) === null) {
            throw new ProtocolError('invalid_request', 'start the move first; the room is still taking writes');
        }
        return transferResponse(store.transferOut(roomId));
    }

    /** Owner or admin: the other relay has the room, so it closes here and says where it went. */
    async commitMove(roomId: string, credential: string, movedTo: MovedTo): Promise<RoomEvent> {
        const store = this.movableStore();
        if (movedTo.roomId !== roomId) {
            throw new ProtocolError('invalid_request', 'a moved room keeps its id');
        }
        if (store.moveLease(roomId, this.now()) === null) {
            throw new ProtocolError('invalid_request', 'the move lease ended; start the move again');
        }
        const event = await this.applyOne(closeMovedRoom(await this.view(roomId), await hashCredential(credential), movedTo, this.ctx()));
        store.setMoveLease(roomId, null);
        return event;
    }

    private movableStore(): MovableStore {
        const {transferOut, moveLease, setMoveLease} = this.store;
        if (!transferOut || !moveLease || !setMoveLease) {
            throw new ProtocolError('unsupported_capability', 'this relay cannot move rooms');
        }
        return {transferOut: transferOut.bind(this.store), moveLease: moveLease.bind(this.store), setMoveLease: setMoveLease.bind(this.store)};
    }

    async read(roomId: string, credential: string, after: number, limit: number, receiptsAfter?: number, sync?: SyncReadOptions): Promise<ReadEventsResponse> {
        return retryRoomConflict(() => this.readAttempt(roomId, credential, after, limit, receiptsAfter, sync));
    }

    private async readAttempt(roomId: string, credential: string, after: number, limit: number, receiptsAfter?: number, sync?: SyncReadOptions): Promise<ReadEventsResponse> {
        const {head: view} = await this.reader(roomId, credential);
        if (after > 0 && after < view.earliestSeq - 1) {
            throw new ProtocolError('cursor_gap', 'history before this cursor is no longer retained', {earliestAvailableSeq: view.earliestSeq});
        }
        const page = await this.store.readEvents(roomId, after, limit, view.room.nextSeq - 1);
        const events = await Promise.all(page.events.map((event) => this.restoreAudience(event)));
        const metadata: Partial<ReadEventsResponse> = {};
        if (sync) {
            metadata.stateRevision = view.room.stateRevision ?? 0;
            metadata.requestRevision = view.room.requestRevision ?? 0;
            metadata.snapshotRevision = view.room.snapshotRevision ?? 0;
            metadata.turnRevision = view.room.turnRevision ?? 0;
            metadata.autoCloseAt = view.room.autoCloseAt ?? null;
            metadata.lastMessageAt = view.room.lastMessageAt ?? null;
            if (sync.snapshotAfter === undefined || sync.snapshotAfter !== metadata.snapshotRevision) {
                metadata.snapshot = this.snapshotOf(await this.view(roomId));
            }
            const current = await this.store.roomHead(roomId);
            if (!current || (current.room.stateRevision ?? 0) !== metadata.stateRevision || current.earliestSeq !== view.earliestSeq) {
                throw new ProtocolError('turn_conflict', 'the room changed during synchronization; retry');
            }
        }
        return {events, earliestSeq: view.earliestSeq, latestSeq: view.room.nextSeq - 1, hasMore: page.hasMore, ...(receiptsAfter !== undefined && this.receiptMode !== 'events' ? receiptsSince(view.room, receiptsAfter) : {}), ...metadata};
    }

    /** Older group events kept the all flag only in their canonical idempotency request. */
    private async restoreAudience(event: RoomEvent): Promise<RoomEvent> {
        if (!event.recipientIds || event.allRecipients !== undefined || !event.idempotencyKey) {
            return event;
        }
        const record = await this.store.idempotencyRecord(event.roomId, event.idempotencyKey);
        if (!record) {
            return event;
        }
        try {
            const request = JSON.parse(record.requestDigest) as Record<string, unknown>;
            return {...event, allRecipients: request['allRecipients'] === true};
        } catch {
            // Unknown historical metadata must not be guessed from today's membership.
            return event;
        }
    }

    async snapshot(roomId: string, credential: string): Promise<RoomSnapshot> {
        const view = await this.view(roomId);
        authenticate(view, await hashCredential(credential), this.now());
        return this.snapshotOf(view);
    }

    async connection(roomId: string, credential: string): Promise<RoomConnection> {
        const view = await this.view(roomId);
        const participant = assertActiveMember(authenticate(view, await hashCredential(credential), this.now()));
        assertRoomWritable(view, this.now());
        return {snapshot: this.snapshotOf(view), participantId: participant.participantId};
    }

    /** Only a transport's authenticated ticket/socket attachment may supply this participant identity. */
    async connectedSnapshot(roomId: string, participantId: string): Promise<RoomSnapshot> {
        const snapshot = await this.connectionAudience(roomId);
        assertConnectedParticipant(snapshot, participantId);
        return snapshot;
    }

    /** Trusted transport projection, loaded once for a broadcast; each attachment still needs participant authorization. */
    async connectionAudience(roomId: string): Promise<RoomSnapshot> {
        const view = await this.view(roomId);
        assertRoomReadable(view, this.now());
        return this.snapshotOf(view);
    }

    /** Returns the history the caller's room still retains, and says so when retention already dropped some. */
    async export(roomId: string, credential: string): Promise<ExportResponse> {
        const source = await this.exportSource(roomId, credential);
        const events: RoomEvent[] = [];
        for await (const event of source.events) {
            events.push(event);
        }
        return {...source.metadata, events};
    }

    async exportStream(roomId: string, credential: string, format: ExportFormat = 'json'): Promise<Response> {
        return exportResponse(await this.exportSource(roomId, credential), format);
    }

    private async exportSource(roomId: string, credential: string): Promise<ExportSource> {
        const view = await this.view(roomId);
        authenticate(view, await hashCredential(credential), this.now());
        const files = this.store.files ? {files: await this.roomFiles(this.store.files, roomId)} : {};
        return {metadata: {room: this.snapshotOf(view), handovers: await this.store.handovers(roomId), exportedAt: this.now(), complete: view.earliestSeq <= 1, ...files}, events: retainedEvents(this.store, roomId, view.earliestSeq, view.room.nextSeq - 1)};
    }

    /**
     * The agent a listing shares: the caller's own participant, an agent still in this open room.
     * `member` is who shares it; an agent that joined as another member is theirs to share.
     */
    async listingSubject(roomId: string, credential: string, member: string): Promise<ListingSubject> {
        const view = await this.view(roomId);
        const now = this.now();
        const actor = authenticate(view, await hashCredential(credential), now);
        assertRoomWritable(view, now);
        if (actor.kind !== 'participant' || actor.participant.kind !== 'agent' || !isActive(actor.participant)) {
            throw new ProtocolError('unauthorized', 'only an agent still in the room can be shared, with its own credential');
        }
        if (actor.participant.member !== undefined && actor.participant.member !== member) {
            throw new ProtocolError('unauthorized', 'this agent joined as another member; only they can share it');
        }
        if (roomType(view.room.policy) === 'personal') {
            throw new ProtocolError('unauthorized', 'agents in a personal room cannot be shared; share one from a room others may join');
        }
        return {participantId: actor.participant.participantId, agentName: actor.participant.displayName, roomName: view.room.name, at: now};
    }

    /** Whether a listing of this participant still stands: the room open and unexpired, the agent still in it. */
    async listable(roomId: string, participantId: string): Promise<boolean> {
        const view = await this.store.loadRoom(roomId, {handovers: false});
        return Boolean(view && this.listableParticipant(view, participantId));
    }

    private listableParticipant(view: RoomView, participantId: string): boolean {
        const participant = findParticipant(view, participantId);
        return Boolean(participant && roomType(view.room.policy) !== 'personal' && view.room.lifecycle === 'open' && (view.room.expiresAt === null || this.now() < view.room.expiresAt) && isActive(participant));
    }

    /** Makes the room inaccessible immediately; physical cleanup may lag. */
    async delete(roomId: string, credential: string): Promise<void> {
        return retryRoomConflict(async () => {
            const view = await this.view(roomId);
            const actor = authenticate(view, await hashCredential(credential), this.now());
            assertController(actor);
            await this.store.setLifecycle(roomId, 'deleted', view.room.stateRevision ?? 0);
            await this.store.deleteRoom(roomId);
        });
    }

    private async applyOne(mutation: Mutation): Promise<RoomEvent> {
        await this.store.apply(mutation, null);
        return mutation.appendEvent;
    }
}

function hexDigest(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type MovableStore = {transferOut: NonNullable<RoomStore['transferOut']>; moveLease: NonNullable<RoomStore['moveLease']>; setMoveLease: NonNullable<RoomStore['setMoveLease']>};

export type StreamDigest = {size: number; sha256: string};

/** Portable incremental verification for storage adapters, without retaining the binary body. */
export async function sha256Stream(body: ReadableStream<Uint8Array>): Promise<StreamDigest> {
    const reader = body.getReader();
    const hash = sha256.create();
    let size = 0;
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) {
                return {size, sha256: hexDigest(hash.digest())};
            }
            size += value.byteLength;
            hash.update(value);
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/** Never retain more than one storage chunk in addition to the transport's current input chunk. */
async function consumeUpload(upload: FileStreamUpload, write: (chunk: Uint8Array) => Promise<void>): Promise<void> {
    const reader = upload.body.getReader();
    const abort = () => { void reader.cancel(upload.signal?.reason).catch(() => {}); };
    upload.signal?.addEventListener('abort', abort, {once: true});
    let total = 0;
    let used = 0;
    let buffer = new Uint8Array(Math.min(FILE_CHUNK_BYTES, upload.size));
    try {
        for (;;) {
            upload.signal?.throwIfAborted();
            const {done, value} = await reader.read();
            upload.signal?.throwIfAborted();
            if (done) {
                break;
            }
            total += value.byteLength;
            if (total > upload.size) {
                throw new ProtocolError('payload_too_large', 'the file is longer than its declared byte length');
            }
            for (let offset = 0; offset < value.byteLength;) {
                const length = Math.min(buffer.byteLength - used, value.byteLength - offset);
                buffer.set(value.subarray(offset, offset + length), used);
                offset += length;
                used += length;
                if (used === buffer.byteLength) {
                    await write(buffer);
                    buffer = new Uint8Array(FILE_CHUNK_BYTES);
                    used = 0;
                }
            }
        }
        if (total !== upload.size) {
            throw new ProtocolError('invalid_request', 'the file is shorter than its declared byte length');
        }
        if (used > 0) {
            await write(buffer.subarray(0, used));
        }
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        upload.signal?.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}

function toAttachment(file: FileRecord): Attachment {
    return {fileId: file.fileId, name: file.name, size: file.size, mediaType: file.mediaType, sha256: file.sha256};
}

function refusedPermissions(permissions: PermissionSet | undefined): PermissionSet | null {
    const refused = Object.fromEntries(Object.entries(permissions ?? {}).filter(([, allowed]) => allowed === false)) as PermissionSet;
    return Object.keys(refused).length ? refused : null;
}

export {DEFAULT_ROOM_POLICY};

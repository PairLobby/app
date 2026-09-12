//! The HTTP client shared by the CLI and the MCP bridge. It turns protocol error
//! bodies back into `ProtocolError`, so callers handle one error type whether a
//! failure came from local validation or from the server.

import {PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, ProtocolError, newCredential, newId} from '@pairlobby/protocol';
import type {AdapterCapabilities, CreateInviteResponse, ErrorCode, ExportResponse, ParticipantKind, ParticipantRole, ReadEventsResponse, RoomEvent, RoomSnapshot, SendEventRequest, SendEventResponse} from '@pairlobby/protocol';

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

    constructor(serverUrl: string) {
        this.serverUrl = serverUrl.replace(/\/+$/, '');
    }

    async createRoom(name: string, identity: ClientIdentity): Promise<CreatedRoom> {
        // Both credentials are generated here, so a lost response never strands a secret the caller does not hold.
        const controllerCredential = newCredential('controller');
        const participantCredential = newCredential('participant');
        const body = await this.call<{room: RoomSnapshot; participantId: string; invite: {code: string; expiresAt: number}}>('POST', '/v1/rooms', null, {name, controllerCredential, participantCredential, ...identity});
        return {roomId: body.room.roomId, participantId: body.participantId, controllerCredential, participantCredential, invite: body.invite, room: body.room};
    }

    /** `attemptId` and the credential must be reused across retries, or a crashed join forks a second membership. */
    async redeemInvite(code: string, identity: ClientIdentity, attempt?: {attemptId: string; participantCredential: string}): Promise<JoinedRoom> {
        const attemptId = attempt?.attemptId ?? newId('attempt');
        const participantCredential = attempt?.participantCredential ?? newCredential('participant');
        const body = await this.call<{roomId: string; participantId: string; role: ParticipantRole; room: RoomSnapshot}>('POST', '/v1/invites/redeem', null, {code, attemptId, attemptSecret: newCredential('attempt'), participantCredential, ...identity});
        return {roomId: body.roomId, participantId: body.participantId, participantCredential, role: body.role, room: body.room};
    }

    snapshot(roomId: string, credential: string): Promise<RoomSnapshot> {
        return this.call('GET', `/v1/rooms/${roomId}`, credential);
    }

    mintInvite(roomId: string, credential: string, role: ParticipantRole = 'member'): Promise<CreateInviteResponse> {
        return this.call('POST', `/v1/rooms/${roomId}/invites`, credential, {role});
    }

    readEvents(roomId: string, credential: string, after: number, limit = 200): Promise<ReadEventsResponse> {
        return this.call('GET', `/v1/rooms/${roomId}/events?after=${after}&limit=${limit}`, credential);
    }

    send(roomId: string, credential: string, request: SendEventRequest): Promise<SendEventResponse> {
        return this.call('POST', `/v1/rooms/${roomId}/events`, credential, request);
    }

    control(roomId: string, credential: string, targetParticipantId: string, paused: boolean): Promise<{revision: number; event: RoomEvent}> {
        return this.call('POST', `/v1/rooms/${roomId}/control`, credential, {targetParticipantId, paused});
    }

    revoke(roomId: string, credential: string, participantId: string): Promise<{event: RoomEvent}> {
        return this.call('DELETE', `/v1/rooms/${roomId}/participants/${participantId}`, credential);
    }

    leave(roomId: string, credential: string): Promise<{event: RoomEvent}> {
        return this.call('POST', `/v1/rooms/${roomId}/leave`, credential, {});
    }

    close(roomId: string, credential: string): Promise<{event: RoomEvent}> {
        return this.call('POST', `/v1/rooms/${roomId}/close`, credential, {});
    }

    export(roomId: string, credential: string): Promise<ExportResponse> {
        return this.call('GET', `/v1/rooms/${roomId}/export`, credential);
    }

    async delete(roomId: string, credential: string): Promise<void> {
        await this.call('DELETE', `/v1/rooms/${roomId}`, credential);
    }

    private async call<T>(method: string, path: string, credential: string | null, body?: unknown): Promise<T> {
        const headers = new Headers({[PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION)});
        if (credential) headers.set('authorization', `Bearer ${credential}`);
        if (body !== undefined) headers.set('content-type', 'application/json');

        let response: Response;
        try {
            response = await fetch(`${this.serverUrl}${path}`, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        } catch {
            throw new ProtocolError('server_unavailable', `could not reach ${this.serverUrl}`, {retryAfterMs: 1000});
        }
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (!response.ok) throw toProtocolError(response.status, text);
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

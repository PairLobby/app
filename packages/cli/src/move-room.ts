//! Moving a room from a relay on this device or network to the account's online relay.
//! The old relay freezes the room, hands over every row, and closes it with a pointer to
//! the new address once the account service holds an identical copy. Every credential
//! moves with the room, so each member's device repoints itself and keeps its seat.

import {createReadStream, mkdtempSync, rmSync, writeFileSync, appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

import {PairLobbyClient} from '@pairlobby/client';
import type {LocalStore, RoomEntry} from '@pairlobby/client';
import {ProtocolError} from '@pairlobby/protocol';
import type {RoomSnapshot} from '@pairlobby/protocol';

import {UsageError} from './context.js';
import {activeEndpoint, tokenMayGo} from './endpoints.js';
import {accountToken, importAbort, importBegin, importCommit, importPreflight, importRecords} from './online.js';
import type {ImportPreflight} from './online.js';
import {receiverConfiguration, startReceiver, stopReceiver} from './receiver.js';
import {isHostedUrl} from './share.js';

/** The most NDJSON sent to the account service in one request. */
const PAGE_BYTES = 4 * 1024 * 1024;
/** How often the old relay's write freeze is renewed while the copy is under way. */
const LEASE_RENEW_MS = 3 * 60_000;

export type MovePlan = {roomId: string; name: string; events: number; files: number; bytes: number; participants: number; preflight: ImportPreflight};
export type MovedRoom = {roomId: string; name: string; serverUrl: string; events: number; files: number; receivers: string[]};
export type MoveOptions = {onProgress?: (step: string) => void; confirm?: (plan: MovePlan) => Promise<boolean>};

/** Why this device cannot move the room online, or null when it can try. */
export function moveBlocker(store: LocalStore, room: RoomEntry): string | null {
    if (isHostedUrl(room.serverUrl)) {
        return 'This room is already online.';
    }
    if (!store.credential(room.roomId, 'controller')) {
        return 'Only the device that holds the room\'s owner credential can move it.';
    }
    const endpoint = activeEndpoint(store);
    if (endpoint.loginMode !== 'browser' || !accountToken(store, endpoint)) {
        return `Log in to ${endpoint.name} first: pairlobby login`;
    }
    return null;
}

/** One line about how big the room is and how much room the account has. */
export function describePlan(plan: MovePlan): string {
    const free = Math.max(0, plan.preflight.limitBytes - plan.preflight.usedBytes);
    return `${plan.events} events and ${plan.files} ${plan.files === 1 ? 'file' : 'files'} (${megabytes(plan.bytes)}) move; your account has ${megabytes(free)} free and ${plan.preflight.rooms} of ${plan.preflight.roomLimit} rooms in use.`;
}

/**
 * Moves the room and repoints this device. Before the old relay closes the room, any
 * failure leaves it exactly as it was; after, the room is online and only this
 * device's saved address could be stale, which `followMovedRoom` repairs.
 */
export async function moveRoomOnline(store: LocalStore, room: RoomEntry, options: MoveOptions = {}): Promise<MovedRoom> {
    const blocked = moveBlocker(store, room);
    if (blocked) {
        throw new UsageError(blocked);
    }
    const progress = options.onProgress ?? (() => {});
    const credential = store.credential(room.roomId, 'controller')!;
    const client = new PairLobbyClient(room.serverUrl);
    const snapshot = await client.snapshot(room.roomId, credential);
    if (!snapshot.moveSupported) {
        throw new UsageError('The relay holding this room cannot move rooms yet. Update PairLobby on that device, then try again.');
    }
    if (snapshot.lifecycle !== 'open') {
        throw new UsageError(`This room is ${snapshot.lifecycle}; only an open room can be moved.`);
    }
    const folder = mkdtempSync(join(tmpdir(), 'pairlobby-move-'));
    const file = join(folder, 'room.ndjson');
    let importId: string | undefined;
    let closed = false;
    progress('Pausing the room…');
    await client.prepareMove(room.roomId, credential);
    const renew = setInterval(() => {
        void client.prepareMove(room.roomId, credential).catch(() => {});
    }, LEASE_RENEW_MS);
    try {
        progress('Reading the room…');
        writeFileSync(file, '', {mode: 0o600});
        let events = 0;
        let files = 0;
        let bytes = 0;
        let participants = 0;
        let digest = '';
        for await (const {line, record} of client.moveTransfer(room.roomId, credential)) {
            appendFileSync(file, line + '\n');
            if (record.kind === 'event') {
                events++;
                bytes += new TextEncoder().encode(JSON.stringify(record.event.payload)).byteLength;
            } else if (record.kind === 'file' || record.kind === 'file-retention') {
                files++;
                bytes += record.file.size;
            } else if (record.kind === 'participant' && record.participant.leftAt === null && record.participant.revokedAt === null) {
                participants++;
            } else if (record.kind === 'complete') {
                digest = record.digest;
            }
        }
        const check = {roomId: room.roomId, name: snapshot.name, bytes, participants};
        const plan: MovePlan = {roomId: room.roomId, name: snapshot.name, events, files, bytes, participants, preflight: await importPreflight(store, check)};
        if (options.confirm && !(await options.confirm(plan))) {
            throw new UsageError('Cancelled; the room was not moved.');
        }
        progress('Copying to your account…');
        importId = await importBegin(store, check);
        let page = '';
        for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) {
            if (page && page.length + line.length + 1 > PAGE_BYTES) {
                await importRecords(store, importId, page);
                page = '';
            }
            page += line + '\n';
        }
        if (page) {
            await importRecords(store, importId, page);
        }
        progress('Checking the copy…');
        const own = [...new Set(room.sessions.map((session) => session.participantId))];
        const imported = await importCommit(store, importId, own);
        if (imported.roomId !== room.roomId || imported.events !== events || imported.files !== files || imported.digest !== digest) {
            throw new ProtocolError('server_unavailable', 'the online copy does not match the room; nothing was changed here');
        }
        importId = undefined;
        progress('Closing the local copy…');
        await client.commitMove(room.roomId, credential, {serverUrl: imported.server, roomId: room.roomId});
        closed = true;
        clearInterval(renew);
        const receivers = await repoint(store, room, imported.server);
        return {roomId: room.roomId, name: snapshot.name, serverUrl: imported.server, events, files, receivers};
    } catch (error) {
        if (!closed) {
            if (importId) {
                await importAbort(store, importId).catch(() => {});
            }
            await client.abortMove(room.roomId, credential).catch(() => {});
        }
        throw error;
    } finally {
        clearInterval(renew);
        client.closeLive();
        rmSync(folder, {recursive: true, force: true});
    }
}

/**
 * A room this device knows that its relay says has moved: when the new address is one
 * this device's login already trusts, saves it and restarts the room's receivers here.
 * Returns the new address, or null when the room has not moved or the address is not trusted.
 */
export async function followMovedRoom(store: LocalStore, room: RoomEntry, snapshot: Pick<RoomSnapshot, 'lifecycle' | 'movedTo'>): Promise<string | null> {
    const serverUrl = movedAddress(store, room, snapshot);
    if (serverUrl) {
        await repoint(store, room, serverUrl);
    }
    return serverUrl;
}

/** The trusted new address of a room that moved, saved for this device without touching its receivers; null otherwise. */
export function saveMovedAddress(store: LocalStore, room: RoomEntry, snapshot: Pick<RoomSnapshot, 'lifecycle' | 'movedTo'>): string | null {
    const serverUrl = movedAddress(store, room, snapshot);
    if (serverUrl) {
        store.upsertRoom({...room, serverUrl});
    }
    return serverUrl;
}

function movedAddress(store: LocalStore, room: RoomEntry, snapshot: Pick<RoomSnapshot, 'lifecycle' | 'movedTo'>): string | null {
    const movedTo = snapshot.movedTo;
    if (snapshot.lifecycle !== 'closed' || !movedTo || movedTo.roomId !== room.roomId || movedTo.serverUrl === room.serverUrl || !tokenMayGo(activeEndpoint(store), movedTo.serverUrl)) {
        return null;
    }
    return movedTo.serverUrl;
}

/** Saves the room's new address and restarts every receiver this device runs for it. */
async function repoint(store: LocalStore, room: RoomEntry, serverUrl: string): Promise<string[]> {
    store.upsertRoom({...room, serverUrl});
    const restarted: string[] = [];
    for (const session of room.sessions) {
        if (session.kind !== 'agent' || !receiverConfiguration(store, session.sessionId)) {
            continue;
        }
        try {
            await stopReceiver(store, session.sessionId);
            await startReceiver(store, room.roomId, session.sessionId);
            restarted.push(session.displayName);
        } catch {
            // The room already moved; a receiver that did not restart here starts on the next `pairlobby receiver start`.
        }
    }
    return restarted;
}

function megabytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

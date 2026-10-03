//! One PairLobby room per Durable Object (a "cell" on Celld). The object owns the
//! room's SQLite state and its alarm; the shared `RoomService` and router supply
//! every protocol behavior, so this file only adapts storage, routing and time.

import {DurableObject} from 'cloudflare:workers';
import {CreateRoomRequest, hashCredential, normalizeInviteCode} from '@pairlobby/protocol';
import {RoomService, createRouter} from '@pairlobby/server-core';

import {DurableRoomStore} from './store.js';
import type {RelayEnv} from './relay.js';
import {ROOM_ID_HEADER, json} from './relay.js';

export class PairLobbyRoom extends DurableObject<RelayEnv> {
    private readonly store: DurableRoomStore;
    private readonly service: RoomService;
    private readonly route: (request: Request) => Promise<Response>;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(ctx: DurableObjectState, env: RelayEnv) {
        super(ctx, env);
        this.store = new DurableRoomStore(ctx.storage);
        this.service = new RoomService(this.store, () => Date.now(), {
            // Codes are global across rooms, so each one is claimed in the directory first.
            reserve: async (code, roomId, expiresAt) => env.INVITES.getByName(await hashCredential(normalizeInviteCode(code)!)).reserve(roomId, expiresAt)
        });
        // The relay Worker already refused browser origins and unexpected hosts.
        this.route = createRouter({service: this.service, allowedOrigins: []});
    }

    /** Requests interleave at every await; one at a time keeps room transitions ordered. */
    private serial<T>(action: () => Promise<T>): Promise<T> {
        const result = this.queue.then(action);
        this.queue = result.catch(() => {});
        return result;
    }

    override fetch(request: Request): Promise<Response> {
        return this.serial(async () => {
            const url = new URL(request.url);
            const response = request.method === 'POST' && url.pathname === '/v1/rooms' ? await this.create(request) : await this.route(request);
            await this.scheduleAutoClose();
            return response;
        });
    }

    /** The relay picked this object's room id before the room existed; use it. */
    private async create(request: Request): Promise<Response> {
        const roomId = request.headers.get(ROOM_ID_HEADER);
        if (!roomId) {
            return json({error: {code: 'invalid_request', message: 'room creation must come through the relay'}}, 400);
        }
        const input = CreateRoomRequest.safeParse(await request.json());
        if (!input.success) {
            return json({error: {code: 'invalid_request', message: 'the request body did not match the protocol schema'}}, 400);
        }
        const created = await this.service.createRoom({...input.data, roomId});
        return json({room: created.snapshot, participantId: created.participantId, invite: created.invite}, 201);
    }

    /** One alarm per room, aimed at its auto-close deadline. */
    private async scheduleAutoClose(): Promise<void> {
        const next = await this.store.nextAutoCloseAt();
        const current = await this.ctx.storage.getAlarm();
        if (next === null) {
            if (current !== null) {
                await this.ctx.storage.deleteAlarm();
            }
            return;
        }
        if (current === null || current !== next) {
            await this.ctx.storage.setAlarm(Math.max(Date.now(), next));
        }
    }

    override async alarm(): Promise<void> {
        await this.serial(async () => {
            await this.service.closeDueRooms();
            await this.scheduleAutoClose();
        });
    }
}

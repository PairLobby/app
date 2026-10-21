//! Checks a deployed relay from the outside, the way a client will use it: health, the
//! address invites show, whether creating rooms needs the token, then one throwaway room
//! through create, join, send, read and delete. Nothing is left behind on success.

import {newCredential, newId} from '@pairlobby/protocol';

import {CREATE_TOKEN_HEADER} from '@pairlobby/server-core';

export type CheckStep = {name: string; ok: boolean; detail: string};

export type CheckOptions = {
    /** Sent when creating the room; needed when the relay requires a create token. */
    createToken?: string;
    fetch?: typeof fetch;
};

type CreatedBody = {room: {roomId: string}; invite: {code: string}};

type JoinedBody = {participantId: string};

type EventsBody = {events: {type: string; payload?: {text?: string}}[]};

type HealthBody = {service?: string; ready?: boolean; version?: string};

type ServerBody = {shareUrls?: string[]; version?: string};

type RoomCredentials = {controllerCredential: string; participantCredential: string};

export async function checkRelay(url: string, {createToken, fetch: fetcher = fetch}: CheckOptions = {}): Promise<CheckStep[]> {
    const origin = new URL(url).origin;
    const steps: CheckStep[] = [];
    let sequence = 0;
    // Each request carries an id the relay writes in its request log, so a failure can be found there.
    const call = (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set('x-request-id', `pairlobby-check-${++sequence}`);
        if (init.body) {
            headers.set('content-type', 'application/json');
        }
        return fetcher(`${origin}${path}`, {...init, headers, signal: AbortSignal.timeout(10_000)});
    };
    const step = (name: string, ok: boolean, detail: string) => {
        steps.push({name, ok, detail});
        return ok;
    };
    const attempt = async (name: string, work: () => Promise<boolean>) => {
        try {
            return await work();
        } catch (error) {
            return step(name, false, error instanceof Error ? error.message : String(error));
        }
    };

    const healthy = await attempt('health', async () => {
        const response = await call('/health');
        const body = (await response.json().catch(() => ({}))) as HealthBody;
        return step('health', response.ok && body.service === 'pairlobby-relay' && body.ready === true, response.ok ? `PairLobby relay ${body.version ?? 'of an unknown version'}` : `GET /health answered ${response.status}; is this the relay, or something in front of it?`);
    });
    if (!healthy) {
        return steps;
    }
    await attempt('invite address', async () => {
        const body = (await (await call('/v1/server')).json()) as ServerBody;
        const shown = body.shareUrls ?? [];
        return step('invite address', shown.includes(origin), shown.includes(origin) ? `invites show ${origin}` : `invites show ${shown.join(', ') || 'no address'}; start the relay with PAIRLOBBY_PUBLIC_URL=${origin}`);
    });

    const credentials: RoomCredentials = {controllerCredential: newCredential('controller'), participantCredential: newCredential('participant')};
    const createBody = JSON.stringify({name: `relay-check-${new Date().toISOString().slice(0, 19)}`, displayName: 'relay-check', kind: 'human', ...credentials});
    let created: CreatedBody | null = null;
    const opened = await attempt('create token', async () => {
        const anonymous = await call('/v1/rooms', {method: 'POST', body: createBody});
        if (anonymous.status === 201) {
            created = (await anonymous.json()) as CreatedBody;
            return step('create token', true, 'not required: anyone who reaches this address can create rooms');
        }
        if (anonymous.status !== 401) {
            return step('create token', false, `creating a room answered ${anonymous.status}`);
        }
        if (!createToken) {
            step('create token', true, 'required, and the relay refused a room without it');
            return step('create room', false, 'set PAIRLOBBY_CREATE_TOKEN to the relay\'s token to check the rest');
        }
        const withToken = await call('/v1/rooms', {method: 'POST', body: createBody, headers: {[CREATE_TOKEN_HEADER]: createToken}});
        if (withToken.status !== 201) {
            return step('create token', false, `required, and the relay answered ${withToken.status} to the token given; is it the same one?`);
        }
        created = (await withToken.json()) as CreatedBody;
        return step('create token', true, 'required, refused without it and accepted with it');
    });
    const room = created as CreatedBody | null;
    if (!opened || !room) {
        return steps;
    }
    const roomPath = `/v1/rooms/${room.room.roomId}`;
    try {
        const joinerCredential = newCredential('participant');
        const joined = await attempt('join', async () => {
            const response = await call('/v1/invites/redeem', {method: 'POST', body: JSON.stringify({code: room.invite.code, displayName: 'relay-check-joiner', kind: 'agent', participantCredential: joinerCredential, attemptId: newId('attempt'), attemptSecret: newCredential('attempt')})});
            return step('join', response.ok, response.ok ? 'joined with the invite code' : `redeeming the invite answered ${response.status}`);
        });
        if (!joined) {
            return steps;
        }
        const text = `relay check ${newId('event')}`;
        const sent = await attempt('send', async () => {
            const response = await call(`${roomPath}/events`, {method: 'POST', body: JSON.stringify({type: 'message', payload: {text}, idempotencyKey: newId('event')}), headers: {authorization: `Bearer ${credentials.participantCredential}`}});
            return step('send', response.status === 201, response.status === 201 ? 'sent a message' : `sending answered ${response.status}`);
        });
        if (sent) {
            await attempt('read', async () => {
                const response = await call(`${roomPath}/events?after=0`, {headers: {authorization: `Bearer ${joinerCredential}`}});
                const found = response.ok && ((await response.json()) as EventsBody).events.some((event) => event.type === 'message' && event.payload?.text === text);
                return step('read', found, found ? 'the other member read it back' : `reading answered ${response.status} without the message`);
            });
        }
    } finally {
        await attempt('delete', async () => {
            const response = await call(roomPath, {method: 'DELETE', headers: {authorization: `Bearer ${credentials.controllerCredential}`}});
            return step('delete', response.status === 204, response.status === 204 ? 'deleted the test room' : `deleting the test room answered ${response.status}; it stays on the relay`);
        });
    }
    return steps;
}

//! `pairlobby visibility`: on a relay with personal logins, which members see a room, and each
//! member's default for their rooms. The relay enforces it; this asks, explains, and after a room
//! is narrowed offers to remove the people in it who no longer see it.

import {PairLobbyClient} from '@pairlobby/client';
import type {LocalStore, RoomEntry} from '@pairlobby/client';
import {canSee, describeVisibility, parseVisibility} from '@pairlobby/protocol';
import type {DefaultVisibility, RoomSnapshot, RoomVisibility} from '@pairlobby/protocol';

import {UsageError, hostedAccountToken, moderationCredential, resolveRoom, resolveServer} from './context.js';
import {requireRelayFeature} from './doctor.js';
import {endpointRelay} from './endpoints.js';
import {json, note, out, visibleTo} from './render.js';
import {DEFAULT_SETUP} from './setup.js';

export const VISIBILITY_USAGE = 'pairlobby visibility <room> [everyone|default|@a,@b], or pairlobby visibility --default [everyone|@a,@b]';

export type VisibilityOptions = {words: string[]; asDefault: boolean; server?: string | undefined; session?: string | undefined; json: boolean};

export type VisibilityDeps = {interactive: boolean; ask: (question: string) => Promise<string>};

const DEFAULT_VISIBILITY_DEPS: VisibilityDeps = {interactive: DEFAULT_SETUP.interactive, ask: DEFAULT_SETUP.ask};

type Outside = {participantId: string; displayName: string};

export async function visibilityCommand(store: LocalStore, options: VisibilityOptions, deps: VisibilityDeps = DEFAULT_VISIBILITY_DEPS): Promise<number> {
    if (options.asDefault) {
        return defaultCommand(store, options);
    }
    const [reference, ...value] = options.words;
    if (!reference) {
        throw new UsageError(VISIBILITY_USAGE);
    }
    const room = resolveRoom(store, reference);
    const client = new PairLobbyClient(room.serverUrl, hostedAccountToken(store, room.serverUrl));
    const credential = moderationCredential(store, room, options.session);
    const snapshot = await client.snapshot(room.roomId, credential);
    if (value.length === 0) {
        return show(client, room, snapshot, options.json);
    }
    await requireRelayFeature(client, 'room-visibility', 'room visibility');
    const visibility = parseVisibility(value.join(' '));
    await client.setVisibility(room.roomId, credential, visibility);
    const outside = await noLongerSeeing(client, room, {...snapshot, visibility});
    if (options.json) {
        json({roomId: room.roomId, visibility, outside});
        return 0;
    }
    out(`${room.name} is now visible to ${visibleTo(visibility)}.`);
    for (const person of outside) {
        if (!deps.interactive) {
            note(`${person.displayName} is still in the room but no longer sees it. Remove them with /kick ${person.displayName} in the room.`);
            continue;
        }
        const answer = (await deps.ask(`${person.displayName} is in the room but no longer sees it. Remove them? [y/N] `)).trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') {
            await client.revoke(room.roomId, credential, person.participantId);
            out(`Removed ${person.displayName}.`);
        }
    }
    return 0;
}

async function show(client: PairLobbyClient, room: RoomEntry, snapshot: RoomSnapshot, asJson: boolean): Promise<number> {
    const visibility = snapshot.visibility ?? 'default';
    const resolved = snapshot.owner && visibility === 'default' ? await ownDefault(client, room, snapshot) : null;
    if (asJson) {
        json({roomId: room.roomId, owner: snapshot.owner ?? null, visibility: snapshot.owner ? visibility : 'everyone', ...(resolved ? {resolved} : {})});
        return 0;
    }
    if (!snapshot.owner) {
        out(`${room.name} is visible to everyone on the relay: it was made without a personal login.`);
        return 0;
    }
    out(`${room.name} is visible to ${visibleTo(visibility)}${resolved ? ` (${resolved === 'everyone' ? 'everyone on the relay' : describeVisibility(resolved)})` : ''}.`);
    return 0;
}

/** The owner's default, when this device is logged in as the owner; null when only the owner could tell. */
async function ownDefault(client: PairLobbyClient, room: RoomEntry, snapshot: RoomSnapshot): Promise<DefaultVisibility | null> {
    const mine = new Set(room.sessions.map((session) => session.participantId));
    const me = snapshot.participants.find((person) => mine.has(person.participantId) && person.member);
    return me?.member === snapshot.owner ? client.memberDefault().catch(() => null) : null;
}

/** People still in the room whom its new visibility leaves out, apart from this device's own sessions. */
async function noLongerSeeing(client: PairLobbyClient, room: RoomEntry, snapshot: RoomSnapshot & {visibility: RoomVisibility}): Promise<Outside[]> {
    const ownerDefault = snapshot.visibility === 'default' ? await ownDefault(client, room, snapshot) : null;
    if (snapshot.visibility === 'default' && ownerDefault === null) {
        return [];
    }
    const mine = new Set(room.sessions.map((session) => session.participantId));
    return snapshot.participants.filter((person) => !person.left && !person.revoked && !mine.has(person.participantId) && !canSee(snapshot, ownerDefault, person.member)).map(({participantId, displayName}) => ({participantId, displayName}));
}

async function defaultCommand(store: LocalStore, options: VisibilityOptions): Promise<number> {
    const server = resolveServer({server: options.server ?? store.profile().server, fallback: endpointRelay(store)});
    const token = hostedAccountToken(store, server);
    if (!token) {
        throw new UsageError('your default visibility is kept by your relay under your login: run pairlobby login first');
    }
    const client = new PairLobbyClient(server, token);
    await requireRelayFeature(client, 'room-visibility', 'room visibility');
    const value = options.words.join(' ').trim();
    let visibility: DefaultVisibility;
    if (value) {
        const parsed = parseVisibility(value);
        if (parsed === 'default') {
            throw new UsageError('your default is everyone or a list of handles, such as @maria,@joe');
        }
        visibility = await client.setMemberDefault(parsed);
    } else {
        visibility = await client.memberDefault();
    }
    if (options.json) {
        json({visibility});
        return 0;
    }
    out(`Your rooms that follow your default are visible to ${visibility === 'everyone' ? 'everyone on the relay' : `${describeVisibility(visibility)} and you`}.`);
    return 0;
}

//! `pairlobby room <room> type`, `invite-policy`, `member` and `admin`: what kind of room it is,
//! whether members may invite, and who may post or manage it. The relay enforces all of them;
//! this only asks and explains.

import {PairLobbyClient} from '@pairlobby/client';
import type {LocalStore, RoomEntry, Settings} from '@pairlobby/client';
import {ROOM_TYPES, ROOM_TYPE_SUMMARY, RoomType, roomPermissions, roomType} from '@pairlobby/protocol';
import type {RoomSnapshot} from '@pairlobby/protocol';

import {UsageError, controllerCredential, moderationCredential, resolveRecipient, resolveRoom} from './context.js';
import {requireRelayFeature} from './doctor.js';
import {publicRoomWarning} from './public-room.js';
import {json, note, out, roleChange} from './render.js';

export const ROOM_USAGE = 'pairlobby room <room> type [public|protected|private|personal], pairlobby room <room> invite-policy [members|owner], or pairlobby room <room> member|admin <name or id>';

export type RoomCommandOptions = {words: string[]; session?: string | undefined; json: boolean};

export type CreateTypeOptions = {type?: string | undefined; openLocal: boolean; online: boolean; settings: Settings};

/** The type a new room asks for: the flag, else what `--open-local` and the device default amount to. Online rooms keep their own privacy. */
export function createType({type, openLocal, online, settings}: CreateTypeOptions): RoomType | undefined {
    if (online) {
        if (type !== undefined) {
            throw new UsageError('--type applies to rooms on your own relay; online rooms use --private or --public');
        }
        return undefined;
    }
    if (type !== undefined) {
        const parsed = parseRoomType(type);
        if (openLocal && parsed !== 'public') {
            throw new UsageError(`--open-local makes a public room; it cannot be combined with --type ${parsed}`);
        }
        return parsed;
    }
    if (openLocal) {
        return 'public';
    }
    return settings.defaultGuestAccess === 'open_to_guests' ? 'protected' : 'private';
}

export function parseRoomType(value: string): RoomType {
    const parsed = RoomType.safeParse(value.trim().toLowerCase());
    if (!parsed.success) {
        throw new UsageError(`room type must be ${ROOM_TYPES.join(', ')}, not "${value}"`);
    }
    return parsed.data;
}

/** Whether members may mint invite codes in this room, after its type and its own permission. */
export function membersMayInvite(snapshot: RoomSnapshot): boolean {
    return roomPermissions(snapshot.policy.permissions, snapshot.policy.type)['invite'];
}

/** One line for a room's type: what it is, and whether members may invite. */
export function roomTypeLine(snapshot: RoomSnapshot): string {
    const type = roomType(snapshot.policy);
    const typed = snapshot.policy.type ? '' : ' (from its settings; this room has no type of its own yet)';
    return `${type}: ${ROOM_TYPE_SUMMARY[type]}${typed}. Members ${membersMayInvite(snapshot) ? 'may' : 'may not'} invite.`;
}

export async function roomCommand(store: LocalStore, reference: string | undefined, options: RoomCommandOptions): Promise<number> {
    const [what, value, ...rest] = options.words;
    if ((what !== 'type' && what !== 'invite-policy' && what !== 'member' && what !== 'admin') || rest.length) {
        throw new UsageError(ROOM_USAGE);
    }
    const room = resolveRoom(store, reference);
    const client = new PairLobbyClient(room.serverUrl);
    if (what === 'member' || what === 'admin') {
        if (value === undefined) {
            throw new UsageError(ROOM_USAGE);
        }
        return setRole(client, store, room, {who: value, role: what === 'admin' ? 'controller' : 'member', session: options.session, json: options.json});
    }
    if (value === undefined) {
        const snapshot = await client.snapshot(room.roomId, moderationCredential(store, room, options.session));
        if (options.json) {
            json({roomId: room.roomId, type: roomType(snapshot.policy), typed: snapshot.policy.type !== undefined, membersMayInvite: membersMayInvite(snapshot)});
            return 0;
        }
        out(`${room.name} is ${roomTypeLine(snapshot)}`);
        return 0;
    }
    if (what === 'type') {
        return setType(client, store, room, parseRoomType(value), options.json);
    }
    return setInvitePolicy(client, store, room, value, options.json);
}

async function setType(client: PairLobbyClient, store: LocalStore, room: RoomEntry, type: RoomType, asJson: boolean): Promise<number> {
    await requireRelayFeature(client, 'room-types', 'room types');
    if (type === 'public') {
        await requireRelayFeature(client, 'local-join', 'public rooms, which are joined by name');
    }
    const credential = controllerCredential(store, room);
    await client.setRoomType(room.roomId, credential, type);
    const snapshot = await client.snapshot(room.roomId, credential);
    // People already in stay: the type decides who joins from now on.
    const mine = new Set(room.sessions.map((session) => session.participantId));
    const present = snapshot.participants.filter((person) => !person.left && !person.revoked && !mine.has(person.participantId));
    const outside = type === 'personal' ? present : type === 'private' ? present.filter((person) => person.role === 'guest') : [];
    if (asJson) {
        json({roomId: room.roomId, type, membersMayInvite: membersMayInvite(snapshot)});
        return 0;
    }
    out(`${room.name} is now ${roomTypeLine(snapshot)}`);
    if (type === 'personal') {
        note('codes made before, or by anyone but you and your admins, no longer admit anyone. Make new ones with: pairlobby invite');
    }
    const agents = snapshot.participants.filter((person) => person.kind === 'agent' && person.role !== 'guest' && !person.left && !person.revoked);
    if (type === 'public' && agents.length) {
        note(`${publicRoomWarning(snapshot.name)} Agents in it now: ${agents.map((person) => person.displayName).join(', ')}. Pause or remove any that should not take requests from everyone.`);
    }
    if (outside.length) {
        note(`still in the room: ${outside.map((person) => person.displayName).join(', ')}. Remove anyone who should not stay with /kick <name> in the room.`);
    }
    return 0;
}

type RoleChange = {who: string; role: 'member' | 'controller'; session?: string | undefined; json: boolean};

/** Makes a visitor a member, who can post, or a member an admin. People get read only again by being muted or removed. */
async function setRole(client: PairLobbyClient, store: LocalStore, room: RoomEntry, {who, role, session, json: asJson}: RoleChange): Promise<number> {
    const credential = moderationCredential(store, room, session);
    const before = await client.snapshot(room.roomId, credential);
    const participantId = resolveRecipient(before.participants, who);
    const person = before.participants.find((participant) => participant.participantId === participantId)!;
    if (person.role === 'guest' && role === 'controller') {
        throw new UsageError(`${person.displayName} is a visitor; make them a member first: pairlobby room ${room.name} member ${who}`);
    }
    await client.setRole(room.roomId, credential, participantId, role);
    if (asJson) {
        json({roomId: room.roomId, participantId, role, previousRole: person.role});
        return 0;
    }
    out(`${person.displayName} is now ${roleChange(role, person.role)} in ${room.name}.`);
    if (role === 'member' && person.role === 'guest' && before.participants.some((participant) => participant.kind === 'agent' && !participant.left && !participant.revoked)) {
        note(`agents in ${room.name} now act on what ${person.displayName} posts.`);
    }
    return 0;
}

async function setInvitePolicy(client: PairLobbyClient, store: LocalStore, room: RoomEntry, value: string, asJson: boolean): Promise<number> {
    if (value !== 'members' && value !== 'owner') {
        throw new UsageError('invite-policy is members (members may invite) or owner (only the owner and admins)');
    }
    const credential = controllerCredential(store, room);
    const before = await client.snapshot(room.roomId, credential);
    if (value === 'members' && before.policy.type === 'personal') {
        throw new UsageError('members never invite in a personal room; make it private or protected first: pairlobby room <room> type private');
    }
    const after = await client.setRoomPermissions(room.roomId, credential, {invite: value === 'members'});
    if (asJson) {
        json({roomId: room.roomId, membersMayInvite: membersMayInvite(after)});
        return 0;
    }
    out(`${room.name}: members ${membersMayInvite(after) ? 'may' : 'may not'} invite. The owner and admins always can.`);
    return 0;
}

//! Which room commands members may use: how the terminal shows it, and the
//! `/permissions` command that changes it. The relay enforces all of it.

import {ProtocolError, ROOM_PERMISSIONS, effectivePermissions, roomPermissions} from '@pairlobby/protocol';
import type {PermissionChange, PermissionSet, RoomPermission, RoomSnapshot} from '@pairlobby/protocol';
import type {PairLobbyClient} from '@pairlobby/client';

export type PermissionCommandContext = {
    client: PairLobbyClient;
    roomId: string;
    credential: string;
    controllerCredential?: string | undefined;
    participantId: string;
};

type PermissionRequest = {action: 'allow' | 'deny' | 'reset'; permissions: RoomPermission[]; target: string};

export const PERMISSION_LABELS: Record<RoomPermission, string> = {
    invite: 'create invites',
    attach: 'send files',
    rename: 'rename the room',
    lock:   'lock and unlock the room',
    mute:   'mute and unmute participants',
    kick:   'remove participants',
    pause:  'pause, resume and interrupt agents',
    turns:  'skip and cancel speaking turns',
};

export const PERMISSION_USAGE = 'Usage: /permissions, or /permissions allow|deny|reset <command …|all> [name]. Commands: ' + ROOM_PERMISSIONS.join(', ');

/**
 * The credential to present for a command: the owner's when this device holds it,
 * otherwise this session's when it is an admin or the room allows the command.
 * Undefined means the relay would refuse, so the caller can say so without asking.
 */
export function authorityFor(snapshot: RoomSnapshot, participantId: string, permission: RoomPermission, credential: string, controllerCredential?: string): string | undefined {
    if (controllerCredential) {
        return controllerCredential;
    }
    const self = snapshot.participants.find((participant) => participant.participantId === participantId);
    if (!self || self.left || self.revoked || self.muted) {
        return undefined;
    }
    return effectivePermissions(self, snapshot.policy.permissions)[permission] ? credential : undefined;
}

export function notPermitted(permission: RoomPermission): ProtocolError {
    return new ProtocolError('unauthorized', `this room does not let you ${PERMISSION_LABELS[permission]}; ask its owner or an admin`);
}

/** What a room-wide change means for members, in terms of what they may now do rather than what was stored. */
export function describeRoomPermissionChange(permissions: PermissionSet, previous: PermissionSet): string {
    const before = roomPermissions(previous);
    const after = roomPermissions(permissions);
    const allowed = ROOM_PERMISSIONS.filter((permission) => after[permission] && !before[permission]);
    const refused = ROOM_PERMISSIONS.filter((permission) => !after[permission] && before[permission]);
    const parts = [allowed.length ? `members may now ${list(allowed)}` : '', refused.length ? `only the owner and admins may now ${list(refused)}` : ''].filter(Boolean);
    return parts.length ? parts.join('; ') : 'command permissions were saved with no effective change';
}

export function describeParticipantPermissionChange(name: string, permissions: PermissionSet, previous: PermissionSet): string {
    const allowed = ROOM_PERMISSIONS.filter((permission) => permissions[permission] === true && previous[permission] !== true);
    const refused = ROOM_PERMISSIONS.filter((permission) => permissions[permission] === false && previous[permission] !== false);
    const cleared = ROOM_PERMISSIONS.filter((permission) => permissions[permission] === undefined && previous[permission] !== undefined);
    const parts = [allowed.length ? `may now ${list(allowed)}` : '', refused.length ? `may no longer ${list(refused)}` : '', cleared.length ? `follows the room's setting again for: ${cleared.join(', ')}` : ''].filter(Boolean);
    return `${name} ${parts.join('; ') || 'kept the same permissions'}`;
}

/** The whole picture for `/permissions`: the room's answer per command, then each member who differs from it. */
export function permissionsReport(snapshot: RoomSnapshot): string {
    const room = roomPermissions(snapshot.policy.permissions);
    const width = Math.max(...ROOM_PERMISSIONS.map((permission) => permission.length));
    const lines = ['Commands members may use (the owner and admins may always use all of them):'];
    for (const permission of ROOM_PERMISSIONS) {
        const decided = snapshot.policy.permissions?.[permission] !== undefined;
        lines.push(`  ${permission.padEnd(width)}  ${room[permission] ? 'members' : 'owner and admins only'}${decided ? '' : ' (default)'} — ${PERMISSION_LABELS[permission]}`);
    }
    const differing = snapshot.participants.filter((person) => !person.left && !person.revoked && person.role === 'member' && Object.keys(person.permissions ?? {}).length > 0);
    if (differing.length) {
        lines.push('Members with their own permissions:');
        for (const person of differing) {
            const own = ROOM_PERMISSIONS.filter((permission) => person.permissions?.[permission] !== undefined).map((permission) => `${permission} ${person.permissions![permission] ? 'allowed' : 'not allowed'}`);
            lines.push(`  ${person.displayName}: ${own.join(', ')}`);
        }
    }
    return lines.join('\n');
}

export function parsePermissionCommand(argument: string): PermissionRequest {
    const [action, ...words] = argument.split(/\s+/).filter(Boolean);
    if (action !== 'allow' && action !== 'deny' && action !== 'reset') {
        throw new Error(PERMISSION_USAGE);
    }
    const permissions: RoomPermission[] = [];
    let index = 0;
    for (; index < words.length; index++) {
        const word = words[index]!.toLowerCase().replace(/,$/, '');
        if (word === 'all') {
            permissions.push(...ROOM_PERMISSIONS);
        } else if ((ROOM_PERMISSIONS as readonly string[]).includes(word)) {
            permissions.push(word as RoomPermission);
        } else {
            break;
        }
    }
    if (permissions.length === 0) {
        throw new Error(PERMISSION_USAGE);
    }
    const target = words.slice(index).join(' ').replace(/^for\s+/i, '');
    return {action, permissions: [...new Set(permissions)], target};
}

export async function runPermissionCommand(argument: string, context: PermissionCommandContext): Promise<string> {
    const {client, roomId, credential, controllerCredential, participantId} = context;
    const snapshot = await client.snapshot(roomId, credential);
    if (!snapshot.permissionsSupported) {
        throw new ProtocolError('unsupported_capability', 'Update this relay before using command permissions.');
    }
    if (!argument.trim()) {
        return permissionsReport(snapshot);
    }
    const {action, permissions, target} = parsePermissionCommand(argument);
    const self = snapshot.participants.find((participant) => participant.participantId === participantId);
    const authority = controllerCredential ?? (self?.role === 'controller' ? credential : undefined);
    if (!authority) {
        throw new ProtocolError('unauthorized', 'only the room owner and admins change command permissions');
    }
    const value = action === 'allow' ? true : action === 'deny' ? false : null;
    const change: PermissionChange = Object.fromEntries(permissions.map((permission) => [permission, value]));
    if (!target) {
        const updated = await client.setRoomPermissions(roomId, authority, change);
        return describeRoomPermissionChange(updated.policy.permissions ?? {}, snapshot.policy.permissions ?? {});
    }
    const person = findMember(snapshot, target);
    const updated = await client.setParticipantPermissions(roomId, authority, person.participantId, change);
    const after = updated.participants.find((participant) => participant.participantId === person.participantId);
    return describeParticipantPermissionChange(person.displayName, after?.permissions ?? {}, person.permissions ?? {});
}

function findMember(snapshot: RoomSnapshot, reference: string): RoomSnapshot['participants'][number] {
    const name = reference.replace(/^@/, '').toLowerCase();
    const matches = snapshot.participants.filter((participant) => !participant.left && !participant.revoked && (participant.participantId === reference || participant.displayName.toLowerCase() === name));
    if (matches.length !== 1) {
        throw new Error(matches.length ? `Several participants are named ${reference}; use their participant ID from /who.` : `No active participant named ${reference}.`);
    }
    return matches[0]!;
}

function list(permissions: RoomPermission[]): string {
    return permissions.map((permission) => PERMISSION_LABELS[permission]).join(', ');
}

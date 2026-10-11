//! Which room commands a plain member may use. The owner and admins may always use
//! all of them and a read-only guest none, so a permission only ever describes members.

import {z} from 'zod';

/**
 * `invite` mints invite codes; `rename` renames the room; `lock` locks and unlocks
 * admission; `mute` and `kick` act on another participant; `pause` pauses, resumes
 * and interrupts an agent; `turns` skips or cancels a speaking turn.
 */
export const ROOM_PERMISSIONS = ['invite', 'rename', 'lock', 'mute', 'kick', 'pause', 'turns'] as const;
export const RoomPermission = z.enum(ROOM_PERMISSIONS);
export type RoomPermission = z.infer<typeof RoomPermission>;

const choice = z.boolean().optional();

/** Only the commands that were decided. An absent command falls back: a member's to the room's, the room's to the built-in default. */
export const PermissionSet = z.object({invite: choice, rename: choice, lock: choice, mute: choice, kick: choice, pause: choice, turns: choice});
export type PermissionSet = z.infer<typeof PermissionSet>;

const change = z.boolean().nullable().optional();

/** `true` allows, `false` refuses, `null` clears the decision so the fallback applies again. */
export const PermissionChange = z.object({invite: change, rename: change, lock: change, mute: change, kick: change, pause: change, turns: change});
export type PermissionChange = z.infer<typeof PermissionChange>;

/** What a member may do in a room nobody has configured: pass an invite along, and nothing that moderates. */
export const DEFAULT_MEMBER_PERMISSIONS: Record<RoomPermission, boolean> = {invite: true, rename: false, lock: false, mute: false, kick: false, pause: false, turns: false};

type PermissionHolder = {role: 'guest' | 'member' | 'controller'; permissions?: PermissionSet | undefined};

/** The room-wide answer for members, with the built-in default filled in. */
export function roomPermissions(room: PermissionSet | undefined): Record<RoomPermission, boolean> {
    return overlay(DEFAULT_MEMBER_PERMISSIONS, room);
}

/** What one participant may actually do: an admin everything, a guest nothing, a member their own decision before the room's. */
export function effectivePermissions(holder: PermissionHolder, room: PermissionSet | undefined): Record<RoomPermission, boolean> {
    if (holder.role !== 'member') {
        const all = holder.role === 'controller';
        return {invite: all, rename: all, lock: all, mute: all, kick: all, pause: all, turns: all};
    }
    return overlay(roomPermissions(room), holder.permissions);
}

/** Applies a change to a set, dropping cleared commands so an empty result means "nothing decided". */
export function applyPermissionChange(current: PermissionSet | undefined, update: PermissionChange): PermissionSet {
    const next: PermissionSet = {...definedPermissions(current)};
    for (const permission of ROOM_PERMISSIONS) {
        const value = update[permission];
        if (value === null) {
            delete next[permission];
        } else if (value !== undefined) {
            next[permission] = value;
        }
    }
    return next;
}

export function samePermissions(left: PermissionSet | undefined, right: PermissionSet | undefined): boolean {
    return ROOM_PERMISSIONS.every((permission) => left?.[permission] === right?.[permission]);
}

function overlay(base: Record<RoomPermission, boolean>, decided: PermissionSet | undefined): Record<RoomPermission, boolean> {
    const result = {...base};
    for (const permission of ROOM_PERMISSIONS) {
        result[permission] = decided?.[permission] ?? base[permission];
    }
    return result;
}

function definedPermissions(set: PermissionSet | undefined): PermissionSet {
    const defined: PermissionSet = {};
    for (const permission of ROOM_PERMISSIONS) {
        const value = set?.[permission];
        if (value !== undefined) {
            defined[permission] = value;
        }
    }
    return defined;
}

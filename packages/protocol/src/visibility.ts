//! Room visibility: which relay members can see a room, and so find it by name, find its agents
//! in the directory, or be let in by a code a member made.
//!
//! A room is `default` (its owner's default, now and whenever that changes), `everyone`, or a
//! list of handles. A member's default is `everyone` until they set one. A room without an owner,
//! made without a personal token, is seen by everyone.

import {z} from 'zod';

import {MemberHandle} from './names.js';

/** At most this many handles in one room's or one member's list. */
export const MAX_VISIBLE_HANDLES = 100;

export const VisibleHandles = z.object({handles: z.array(MemberHandle).min(1).max(MAX_VISIBLE_HANDLES)});
export type VisibleHandles = z.infer<typeof VisibleHandles>;

/** A member's default for their rooms. */
export const DefaultVisibility = z.union([z.literal('everyone'), VisibleHandles]);
export type DefaultVisibility = z.infer<typeof DefaultVisibility>;

/** A room's own setting; absent on a room means `default`. */
export const RoomVisibility = z.union([z.literal('default'), DefaultVisibility]);
export type RoomVisibility = z.infer<typeof RoomVisibility>;

type VisibleRoom = {owner?: string | undefined; visibility?: RoomVisibility | undefined};

/** Who a room is visible to once its owner's default is applied: everyone, or these handles and its owner. */
export function resolveVisibility({owner, visibility}: VisibleRoom, ownerDefault: DefaultVisibility | null): DefaultVisibility {
    if (!owner) {
        return 'everyone';
    }
    const own = visibility ?? 'default';
    return own === 'default' ? ownerDefault ?? 'everyone' : own;
}

/** Whether the member with this handle sees the room. The owner always does; no handle, only a room seen by everyone. */
export function canSee(room: VisibleRoom, ownerDefault: DefaultVisibility | null, handle: string | null | undefined): boolean {
    const resolved = resolveVisibility(room, ownerDefault);
    if (resolved === 'everyone') {
        return true;
    }
    return Boolean(handle) && (handle === room.owner || resolved.handles.includes(handle!));
}

/** `everyone`, `default`, or handles separated by commas or spaces, each with or without its `@`. */
export function parseVisibility(value: string): RoomVisibility {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'everyone' || trimmed === 'default') {
        return trimmed;
    }
    const handles = [...new Set(trimmed.split(/[\s,]+/).filter(Boolean).map((handle) => handle.replace(/^@/, '')))];
    return VisibleHandles.parse({handles});
}

/** `everyone`, `default`, or `@a @b`. */
export function describeVisibility(visibility: RoomVisibility): string {
    return typeof visibility === 'string' ? visibility : visibility.handles.map((handle) => `@${handle}`).join(' ');
}

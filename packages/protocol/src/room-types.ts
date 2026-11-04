//! Room types: who can find a room, who can join it, and who can post.
//!
//! A type sets the room's existing switches, so every relay enforces it with the rules it
//! already has. Rooms created before types have none; they keep the switches they have and
//! read as the type those switches amount to.

import {z} from 'zod';

/**
 * `public`: anyone the relay admits finds it and joins as a member. `protected`: anyone joins as
 * a visitor; the owner adds members. `private`: members only. `personal`: the owner and the
 * owner's own agents only.
 */
export const ROOM_TYPES = ['public', 'protected', 'private', 'personal'] as const;
export const RoomType = z.enum(ROOM_TYPES);
export type RoomType = z.infer<typeof RoomType>;

/** The switches a type sets: joining by name as a member, and joining by room id as a visitor. */
export type RoomTypeAccess = {localJoin: boolean; joinPolicy: 'invite_only' | 'open_to_guests'};

export const ROOM_TYPE_ACCESS: Record<RoomType, RoomTypeAccess> = {
    public: {localJoin: true, joinPolicy: 'invite_only'},
    protected: {localJoin: false, joinPolicy: 'open_to_guests'},
    private: {localJoin: false, joinPolicy: 'invite_only'},
    personal: {localJoin: false, joinPolicy: 'invite_only'},
};

type TypedPolicy = {type?: RoomType | undefined; localJoin?: boolean | undefined; joinPolicy: 'invite_only' | 'open_to_guests'};

/** The room's type, or for a room from before types, the type its switches amount to. */
export function roomType(policy: TypedPolicy): RoomType {
    if (policy.type) {
        return policy.type;
    }
    if (policy.localJoin) {
        return 'public';
    }
    return policy.joinPolicy === 'open_to_guests' ? 'protected' : 'private';
}

/** One line for each type, for help text and settings. */
export const ROOM_TYPE_SUMMARY: Record<RoomType, string> = {
    public: 'anyone the relay admits can find it and join as a member',
    protected: 'anyone can join as a read-only visitor; the owner adds members',
    private: 'only people with an invite code can join',
    personal: 'only its owner and the owner\'s own agents can join',
};

//! Rooms that close themselves. Every mutation recomputes one stored deadline, in
//! the same atomic write, so closing never depends on a timer surviving: the
//! scheduler, a restart or the next request all find the same overdue deadline.
//! The deadline is recomputed from current state, so a stale wake-up cannot close
//! a room whose policy or activity has since moved its deadline.

import {ProtocolError} from '@pairlobby/protocol';
import type {AutoClosePolicy, CloseReason, ParticipantRecord, RoomEvent, RoomRecord} from '@pairlobby/protocol';

import {appendEvent} from './append.js';
import {assertController, assertRoomWritable, authenticate} from './authorize.js';
import {emptyMutation, type CoreContext, type Mutation, type RoomView} from './state.js';

const OFF: AutoClosePolicy = {mode: 'off'};

export function autoClosePolicy(room: RoomRecord): AutoClosePolicy {
    return room.policy.autoClose ?? OFF;
}

function countsForDeparture(participant: ParticipantRecord): boolean {
    return participant.kind === 'agent' || participant.role === 'guest';
}

function present(participant: ParticipantRecord): boolean {
    return participant.leftAt === null && participant.revokedAt === null;
}

/**
 * Brings the auto-close fields up to date after a mutation. `participants` is the
 * membership after the mutation; `appended` is the event it adds, if any. Only an
 * accepted `message` (replies and progress included) moves the inactivity clock.
 */
export function refreshAutoClose(room: RoomRecord, participants: ParticipantRecord[], appended: RoomEvent | null, now: number): RoomRecord {
    const lastMessageAt = appended?.type === 'message' ? appended.at : (room.lastMessageAt ?? null);
    // Membership records outlive departures, so "has one ever joined" needs no extra history.
    const armed = participants.some(countsForDeparture);
    const policy = autoClosePolicy(room);
    let deadline: number | null = null;
    if (room.lifecycle === 'open') {
        switch (policy.mode) {
            case 'inactivity':             deadline = (lastMessageAt ?? room.createdAt) + policy.afterMs; break;
            case 'age':                    deadline = room.createdAt + policy.afterMs; break;
            case 'agents_and_guests_left': deadline = armed && !participants.some((participant) => present(participant) && countsForDeparture(participant)) ? (room.autoCloseAt ?? now) : null; break;
            case 'off':                    deadline = null; break;
        }
    }
    return {...room, lastMessageAt, autoCloseArmed: armed, autoCloseAt: deadline};
}

/** The reason an open room must close now, or null. An expired room is left to expiry. */
export function autoCloseDue(view: RoomView, now: number): CloseReason | null {
    const {room} = view;
    if (room.lifecycle !== 'open' || room.autoCloseAt === undefined || room.autoCloseAt === null || now < room.autoCloseAt) {
        return null;
    }
    if (room.expiresAt !== null && now >= room.expiresAt) {
        return null;
    }
    const policy = autoClosePolicy(room);
    return policy.mode === 'off' ? null : policy.mode;
}

function close(view: RoomView, senderId: string | null, reason: CloseReason, ctx: CoreContext): Mutation {
    const closed: RoomRecord = {...view.room, lifecycle: 'closed', closedAt: ctx.now, closeReason: reason, autoCloseAt: null};
    const {room, event} = appendEvent(
        closed,
        {senderId, idempotencyKey: null, recipientId: null, replyTo: null, body: {type: 'room.closed', payload: {exportWindowEndsAt: ctx.now + view.room.policy.exportWindowMs, reason}}},
        ctx
    );
    return emptyMutation(room, event);
}

/** The server-authored close. Callers check `autoCloseDue` against freshly loaded state first. */
export function autoCloseRoom(view: RoomView, reason: CloseReason, ctx: CoreContext): Mutation {
    return close(view, null, reason, ctx);
}

export function closeRoom(view: RoomView, credentialHash: string, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    return close(view, actor.kind === 'participant' ? actor.participant.participantId : null, 'manual', ctx);
}

function samePolicy(left: AutoClosePolicy, right: AutoClosePolicy): boolean {
    return left.mode === right.mode && ('afterMs' in left ? left.afterMs : null) === ('afterMs' in right ? right.afterMs : null);
}

/** Owner or admin only. A policy that is already overdue closes the room on its next load. */
export function setAutoClose(view: RoomView, credentialHash: string, autoClose: AutoClosePolicy, ctx: CoreContext): Mutation {
    const actor = authenticate(view, credentialHash, ctx.now);
    assertController(actor);
    assertRoomWritable(view, ctx.now);
    const previous = autoClosePolicy(view.room);
    if (samePolicy(previous, autoClose)) {
        throw new ProtocolError('invalid_request', 'the room already uses that auto-close setting');
    }
    const updated = {...view.room, policy: {...view.room.policy, autoClose}, autoCloseAt: null};
    const {room, event} = appendEvent(
        updated,
        {senderId: actor.kind === 'participant' ? actor.participant.participantId : null, idempotencyKey: null, recipientId: null, replyTo: null, body: {type: 'room.auto_close_changed', payload: {autoClose, previous}}},
        ctx
    );
    return emptyMutation(room, event);
}

//! The bounded slice of a room a transition needs, and the atomic mutation it
//! produces. Events are appended, never materialized in full: a room may retain
//! twenty thousand of them.

import type {ControlRecord, HandoverRecord, ParticipantRecord, ParticipantView, RoomEvent, RoomRecord, RoomSnapshot} from '@pairlobby/protocol';

export interface RoomView {
    room: RoomRecord;
    participants: ParticipantRecord[];
    handovers: HandoverRecord[];
    controls: ControlRecord[];
    earliestSeq: number;
}

/** Applied by a storage adapter in one transaction, together with the idempotency record. */
export interface Mutation {
    room: RoomRecord;
    appendEvent: RoomEvent;
    upsertParticipants: ParticipantRecord[];
    upsertHandovers: HandoverRecord[];
    upsertControls: ControlRecord[];
}

export interface CoreContext {
    now: number;
    newEventId: () => string;
}

export function emptyMutation(room: RoomRecord, appendEvent: RoomEvent): Mutation {
    return {room, appendEvent, upsertParticipants: [], upsertHandovers: [], upsertControls: []};
}

export function findParticipant(view: RoomView, participantId: string): ParticipantRecord | undefined {
    return view.participants.find((participant) => participant.participantId === participantId);
}

export function controlFor(view: RoomView, participantId: string): ControlRecord | undefined {
    return view.controls.find((control) => control.targetParticipantId === participantId);
}

export function isActive(participant: ParticipantRecord): boolean {
    return participant.revokedAt === null && participant.leftAt === null;
}

export function activeParticipants(view: RoomView): ParticipantRecord[] {
    return view.participants.filter(isActive);
}

/**
 * Resolves a display name to a participant. Duplicate names are never routed by
 * guess: an ambiguous name returns every match so the caller can show ids.
 */
export function participantsByDisplayName(view: RoomView, displayName: string): ParticipantRecord[] {
    const wanted = displayName.trim().toLowerCase();
    return activeParticipants(view).filter((participant) => participant.displayName.toLowerCase() === wanted);
}

export function toParticipantView(view: RoomView, participant: ParticipantRecord): ParticipantView {
    const control = controlFor(view, participant.participantId);
    return {
        participantId: participant.participantId,
        displayName: participant.displayName,
        kind: participant.kind,
        role: participant.role,
        capabilities: participant.capabilities,
        joinedAt: participant.joinedAt,
        revoked: participant.revokedAt !== null,
        left: participant.leftAt !== null,
        paused: control?.paused ?? false,
        controlRevision: control?.revision ?? 0,
        acknowledgedOutcome: control?.acknowledgedOutcome ?? null,
    };
}

export function toSnapshot(view: RoomView): RoomSnapshot {
    return {
        roomId: view.room.roomId,
        name: view.room.name,
        lifecycle: view.room.lifecycle,
        createdAt: view.room.createdAt,
        expiresAt: view.room.expiresAt,
        closedAt: view.room.closedAt,
        controlRevision: view.room.controlRevision,
        latestSeq: view.room.nextSeq - 1,
        earliestSeq: view.earliestSeq,
        participants: view.participants.map((participant) => toParticipantView(view, participant)),
        policy: view.room.policy,
    };
}

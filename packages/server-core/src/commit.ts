import {ProtocolError} from '@pairlobby/protocol';
import type {RoomRecord} from '@pairlobby/protocol';
import type {Mutation} from '@pairlobby/room-core';

export type RoomChanges = {requests?: boolean; snapshot?: boolean};

/** The next state is based on this exact persisted revision, including changes without events. */
export function committedRoom(current: RoomRecord | null, proposed: RoomRecord, changes: RoomChanges = {}): RoomRecord {
    if (!current || (current.stateRevision ?? 0) !== (proposed.stateRevision ?? 0)) {
        throw new ProtocolError('turn_conflict', 'the room state changed; retry the operation');
    }
    return {
        ...proposed,
        stateRevision: (current.stateRevision ?? 0) + 1,
        requestRevision: (current.requestRevision ?? 0) + (changes.requests ? 1 : 0),
        snapshotRevision: (current.snapshotRevision ?? 0) + (changes.snapshot ? 1 : 0)
    };
}

export function mutationChanges(mutation: Mutation): RoomChanges {
    const type = mutation.appendEvent.type;
    const mode = mutation.appendEvent.type === 'conversation.turn_changed' && mutation.appendEvent.payload.action === 'mode';
    return {requests: Boolean(mutation.upsertRequests?.length), snapshot: type.startsWith('room.') || type.startsWith('participant.') || type.startsWith('control.') || mode};
}

/** Retries only a rejected optimistic commit. A store must never report a conflict after committing. */
export async function retryRoomConflict<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await action();
        } catch (error) {
            if (!(error instanceof ProtocolError) || error.code !== 'turn_conflict' || attempt >= 5) {
                throw error;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(Math.random() * Math.min(2 ** attempt, 25))));
        }
    }
}

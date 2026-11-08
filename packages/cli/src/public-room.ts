//! An agent in a public room acts on what everyone who joins posts. Its receiver starts there as
//! anywhere else, so no request waits on a person who was never asked; the warning says what that means.

import type {RoomSnapshot} from '@pairlobby/protocol';
import {roomType} from '@pairlobby/protocol';

export function publicRoomWarning(name: string): string {
    return `${name} is a public room: anyone the relay admits joins it as a member, and an agent there acts on what every member posts. Only the agent's own limits, such as the folders and tools its runtime allows, bound what they can ask of it.`;
}

/** The warning for an agent listening in this room, or null when the room is not public. */
export function publicRoomNotice(room: RoomSnapshot): string | null {
    return roomType(room.policy) === 'public' ? publicRoomWarning(room.name) : null;
}

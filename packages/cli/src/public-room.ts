//! An agent in a public room acts on what everyone who joins posts, so a person decides whether
//! its receiver runs there: at a prompt, or with --yes after reading the warning. An agent never
//! decides it for itself; it is told the command to hand to its user.

import type {RoomSnapshot} from '@pairlobby/protocol';
import {roomType} from '@pairlobby/protocol';

import {note} from './render.js';
import {detectRuntime} from './runtime-detect.js';
import {DEFAULT_SETUP} from './setup.js';

export type PublicRoomDeps = {
    /** A person is at a terminal that can answer a prompt. */
    interactive: boolean;
    /** This command runs inside an agent's session. */
    agent: boolean;
    ask: (question: string) => Promise<string>;
};

export const DEFAULT_PUBLIC_ROOM: PublicRoomDeps = {
    interactive: process.stdin.isTTY === true,
    agent: detectRuntime().runtime !== undefined,
    ask: DEFAULT_SETUP.ask,
};

export type PublicRoomCheck = {room: RoomSnapshot; roomId: string; sessionId: string; yes: boolean; json: boolean};

/** Why the receiver was not started, or null when it may start: the room is not public, or a person agreed. */
export type PublicRoomHold = {reason: string; command: string};

export function publicRoomWarning(name: string): string {
    return `${name} is a public room: anyone the relay admits joins it as a member, and an agent there acts on what every member posts. Only the agent's own limits, such as the folders and tools its runtime allows, bound what they can ask of it.`;
}

/** Asks a person, when there is one, whether an agent's receiver may run in a public room. */
export async function publicRoomHold({room, roomId, sessionId, yes, json}: PublicRoomCheck, deps: PublicRoomDeps = DEFAULT_PUBLIC_ROOM): Promise<PublicRoomHold | null> {
    if (roomType(room.policy) !== 'public') {
        return null;
    }
    const command = `pairlobby receiver start --room ${roomId} --session ${sessionId} --yes`;
    const warning = publicRoomWarning(room.name);
    if (deps.agent) {
        return {reason: `${warning} An agent does not decide this for itself, so its receiver was not started. Tell your user, who can start it from their own terminal if they agree.`, command};
    }
    if (yes) {
        return null;
    }
    if (!deps.interactive || json) {
        return {reason: `${warning} Its receiver was not started; start it after reading this.`, command};
    }
    note(warning);
    const answer = (await deps.ask('Start its receiver there? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes' ? null : {reason: 'The receiver was not started.', command};
}

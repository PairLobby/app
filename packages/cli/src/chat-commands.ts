import {ProtocolError} from '@pairlobby/protocol';
import type {RoomSnapshot} from '@pairlobby/protocol';
import type {PairLobbyClient} from '@pairlobby/client';

export type RoomCommandContext = {
    client: PairLobbyClient;
    roomId: string;
    credential: string;
    controllerCredential?: string | undefined;
    participantId: string;
};

export function isRoomCommand(line: string): boolean {
    return /^\/(invite|lock|unlock|kick|mute|unmute)(?:\s|$)/.test(line);
}

function targetParticipant(snapshot: RoomSnapshot, reference: string): string {
    const name = reference.replace(/^@/, '').toLowerCase();
    const matches = snapshot.participants.filter((participant) => !participant.left && !participant.revoked && (participant.participantId === reference || participant.displayName.toLowerCase() === name));
    if (matches.length !== 1) {
        throw new Error(matches.length ? `Several participants are named ${reference}; use their participant ID from /who.` : `No active participant named ${reference}.`);
    }
    return matches[0]!.participantId;
}

export async function runRoomCommand(line: string, context: RoomCommandContext): Promise<string> {
    const {client, roomId, credential, controllerCredential, participantId} = context;
    const snapshot = await client.snapshot(roomId, credential);
    const member = snapshot.participants.find((participant) => participant.participantId === participantId);
    if (!member || member.role === 'guest') {
        throw new ProtocolError('unauthorized', 'observers cannot use room commands');
    }
    const [command] = line.split(/\s+/);
    const argument = line.slice(command!.length).trim();
    if (command === '/invite') {
        if (argument && !/^as\s+\S/.test(argument)) {
            throw new Error('Usage: /invite or /invite as <name>');
        }
        const defaultName = argument ? argument.slice(3).trim() : undefined;
        const invite = await client.mintInvite(roomId, credential, defaultName ? 'member' : 'guest', true, undefined, defaultName);
        return `Invite: ${invite.code} — ${defaultName ? `participant, default name: ${defaultName}` : 'read-only observer'}`;
    }
    const owner = controllerCredential ?? (member.role === 'controller' ? credential : undefined);
    if (!owner) {
        throw new ProtocolError('unauthorized', 'this command requires the room owner');
    }
    if (command === '/lock' || command === '/unlock') {
        if (argument) {
            throw new Error(`Usage: ${command}`);
        }
        await client.setLocked(roomId, owner, command === '/lock');
        return command === '/lock' ? 'Room locked. Joining, rejoining, and new invites are disabled.' : 'Room unlocked. Invites and joining are enabled again.';
    }
    if (!argument) {
        throw new Error(`Usage: ${command} <name or participant ID>`);
    }
    const target = targetParticipant(snapshot, argument);
    if (command === '/kick') {
        if (target === participantId) {
            throw new Error('Use /quit to leave the room.');
        }
        await client.revoke(roomId, owner, target);
        return `${argument} was kicked. Their credential and invite seat can no longer be used.`;
    }
    if (command === '/mute' || command === '/unmute') {
        await client.setMuted(roomId, owner, target, command === '/mute');
        return `${argument} was ${command === '/mute' ? 'muted' : 'unmuted'}.`;
    }
    throw new Error('Unknown room command.');
}

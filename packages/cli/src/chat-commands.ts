import {ParticipantName, ProtocolError} from '@pairlobby/protocol';
import type {RoomSnapshot} from '@pairlobby/protocol';
import type {PairLobbyClient} from '@pairlobby/client';
import {joinCommand} from './share.js';
import {formatTurnQueue, runTurnCommand} from './turn-commands.js';

export type RoomCommandContext = {
    client: PairLobbyClient;
    roomId: string;
    credential: string;
    controllerCredential?: string | undefined;
    participantId: string;
};

export function isRoomCommand(line: string): boolean {
    return /^\/(name|invite|lock|unlock|kick|mute|unmute|turns)(?:\s|$)/.test(line);
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
    if (command === '/name') {
        const parsed = ParticipantName.safeParse(argument);
        if (!parsed.success) {
            throw new Error('Usage: /name <new name> (1–64 characters, no control characters; all is reserved)');
        }
        if (!snapshot.renameSelfSupported) {
            throw new ProtocolError('unsupported_capability', 'Update this relay before using /name.');
        }
        await client.renameSelf(roomId, credential, parsed.data);
        return `Your name in this room is ${parsed.data}. Your default profile is unchanged.`;
    }
    if (command === '/turns') {
        return formatTurnQueue(await runTurnCommand(argument, context), true);
    }
    if (command === '/invite') {
        if (argument && !/^as\s+\S/.test(argument) && !['member', 'observer'].includes(argument)) {
            throw new Error('Usage: /invite, /invite member, /invite observer or /invite as <name>');
        }
        const defaultName = /^as\s/.test(argument) ? argument.slice(3).trim() : undefined;
        // A named invite or an explicit choice wins; otherwise the room's /settings default, which is member.
        const role = defaultName || argument === 'member' ? 'member' : argument === 'observer' ? 'guest' : snapshot.policy.inviteRole ?? 'member';
        const invite = await client.mintInvite(roomId, credential, role, true, undefined, defaultName);
        const share = await joinCommand(client.serverUrl, invite.code);
        const reach = share.target.discoverable ? ` (on your network or tailnet, pairlobby join ${invite.code} is enough)` : !share.target.localOnly ? '' : share.target.otherRelay ? ' (this device only; other devices need an address of this relay they can reach)' : ' (this device only; share it with pairlobby settings network-sharing, then restart the relay)';
        const admits = role === 'guest' ? 'read-only observer' : defaultName ? `member who can speak, default name: ${defaultName}` : 'member who can speak';
        return `Invite: ${invite.code} — ${admits} · ${share.command}${reach}`;
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

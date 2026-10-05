import {ParticipantName, ProtocolError} from '@pairlobby/protocol';
import type {RoomSnapshot} from '@pairlobby/protocol';
import type {PairLobbyClient, RoomInvitation} from '@pairlobby/client';
import {isHostedUrl, joinCommand} from './share.js';
import {formatTurnQueue, runTurnCommand} from './turn-commands.js';

export type RoomCommandContext = {
    client: PairLobbyClient;
    roomId: string;
    credential: string;
    controllerCredential?: string | undefined;
    participantId: string;
};

export function isRoomCommand(line: string): boolean {
    return /^\/(name|invite|invites|lock|unlock|kick|mute|unmute|turns)(?:\s|$)/.test(line);
}

function targetParticipant(snapshot: RoomSnapshot, reference: string): string {
    const name = reference.replace(/^@/, '').toLowerCase();
    const matches = snapshot.participants.filter((participant) => !participant.left && !participant.revoked && (participant.participantId === reference || participant.displayName.toLowerCase() === name));
    if (matches.length !== 1) {
        throw new Error(matches.length ? `Several participants are named ${reference}; use their participant ID from /who.` : `No active participant named ${reference}.`);
    }
    return matches[0]!.participantId;
}

function invitationTerms(invitation: RoomInvitation): string {
    const agents = invitation.agents === 0 ? 'no agents' : `may bring ${invitation.agents} agent${invitation.agents === 1 ? '' : 's'}`;
    return `${invitation.role === 'guest' ? 'read-only observer' : 'member'}, ${agents}`;
}

/** `/invite @maria @joe observer`: each handle is asked separately, so one unknown name does not stop the others. */
async function inviteHandles(argument: string, client: PairLobbyClient, roomId: string, authority: string): Promise<string> {
    const words = argument.split(/\s+/).filter(Boolean);
    const handles = [...new Set(words.filter((word) => word.startsWith('@')).map((word) => word.toLowerCase()))];
    const rest = words.filter((word) => !word.startsWith('@'));
    if (rest.length > 1 || (rest[0] !== undefined && !['member', 'observer'].includes(rest[0])) || handles.some((handle) => handle.length < 2)) {
        throw new Error('Usage: /invite @handle [@handle …] [member|observer]');
    }
    const role = rest[0] === 'observer' ? 'observer' : 'member';
    const lines: string[] = [];
    for (const handle of handles) {
        try {
            const invitation = await client.inviteAccount(roomId, authority, handle, role);
            lines.push(`Invited @${invitation.handle} — ${invitationTerms(invitation)} · they accept with pairlobby invitations · expires ${new Date(invitation.expiresAt).toLocaleDateString()}`);
        } catch (error) {
            lines.push(`${handle} was not invited: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return lines.join('\n');
}

/** `/invites` lists who was asked in; `/invites revoke @maria` withdraws an unanswered one. */
async function roomInvitations(argument: string, client: PairLobbyClient, roomId: string, authority: string): Promise<string> {
    const invitations = await client.roomInvitations(roomId, authority);
    const revoke = /^revoke\s+@?(\S+)$/.exec(argument);
    if (revoke) {
        const target = invitations.find((invitation) => invitation.handle === revoke[1]!.toLowerCase());
        if (!target) {
            throw new Error(`No invitation to @${revoke[1]} in this room.`);
        }
        if (target.state === 'accepted') {
            throw new Error(`@${target.handle} already accepted; remove them from the room with /kick instead.`);
        }
        await client.revokeInvitation(roomId, authority, target.id);
        return `Invitation to @${target.handle} withdrawn.`;
    }
    if (argument) {
        throw new Error('Usage: /invites or /invites revoke @handle');
    }
    if (invitations.length === 0) {
        return 'Nobody has been invited to this room by handle. Invite with /invite @handle.';
    }
    return invitations.map((invitation) => `@${invitation.handle} — ${invitationTerms(invitation)} · ${invitation.state === 'accepted' ? 'accepted' : `not answered yet, expires ${new Date(invitation.expiresAt).toLocaleDateString()}`}`).join('\n');
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
    if (command === '/invites' || (command === '/invite' && /(^|\s)@/.test(argument))) {
        // Asking a named account in is for whoever runs the room; anyone may still pass a code along.
        const authority = controllerCredential ?? (member.role === 'controller' ? credential : undefined);
        if (!isHostedUrl(client.serverUrl)) {
            throw new Error('Inviting by @handle works in hosted rooms (pairlobby create online), where people have accounts. This room is on your own relay: /invite gives a code to pass along.');
        }
        if (!authority) {
            throw new ProtocolError('unauthorized', 'only the room owner and admins invite by @handle; /invite gives you a code to pass along');
        }
        return command === '/invites' ? roomInvitations(argument, client, roomId, authority) : inviteHandles(argument, client, roomId, authority);
    }
    if (command === '/invite') {
        if (/\S+@\S+\.\S+/.test(argument)) {
            throw new Error('Inviting by email is not available yet. Invite an account with /invite @handle, or use /invite for a code.');
        }
        if (argument && !/^as\s+\S/.test(argument) && !['member', 'observer'].includes(argument)) {
            throw new Error('Usage: /invite, /invite member, /invite observer, /invite as <name>, or /invite @handle [observer]');
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

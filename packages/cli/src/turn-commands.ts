import {ProtocolError} from '@pairlobby/protocol';
import {stripVTControlCharacters} from 'node:util';
import type {TurnAction, TurnQueue} from '@pairlobby/protocol';
import type {RoomCommandContext} from './chat-commands.js';

export function formatTurnQueue(queue: TurnQueue, details = false): string {
    const priorities = {answering: 0, stalled: 1, waiting: 2, paused: 3, unavailable: 4, failed: 5};
    const shown = [...queue.entries].sort((a, b) => priorities[a.state] - priorities[b.state]).slice(0, details ? 50 : 4);
    const entries = shown.map((entry) => `${stripVTControlCharacters(entry.name)}: ${entry.state}${details ? ` [${entry.requestId}] round ${entry.conversationId}` : ''}`);
    const more = queue.entries.length > shown.length ? ` | +${queue.entries.length - shown.length} more` : '';
    return `Turns: ${queue.mode}${entries.length ? ` | ${entries.join(details ? '\n' : ' → ')}` : ' | ready'}${more}`;
}

export async function runTurnCommand(argument: string, context: RoomCommandContext): Promise<TurnQueue> {
    const {client, roomId, credential, controllerCredential} = context;
    const snapshot = await client.snapshot(roomId, credential);
    if (!snapshot.groupTurnsSupported) {
        throw new Error('Update this relay to use speaking turns.');
    }
    if (!argument.trim()) {
        return client.turnQueue(roomId, credential);
    }
    const owner = controllerCredential ?? (snapshot.participants.find((participant) => participant.participantId === context.participantId)?.role === 'controller' ? credential : undefined);
    if (!owner) {
        throw new ProtocolError('unauthorized', 'only the room owner may change or skip speaking turns');
    }
    if (argument === 'sequential' || argument === 'parallel') {
        return client.setTurnMode(roomId, owner, argument);
    }
    const [command, ...words] = argument.split(/\s+/);
    if (command !== 'skip' && command !== 'cancel') {
        throw new Error('Usage: /turns [sequential|parallel|skip [name or request]|cancel [request]]');
    }
    const reference = words.join(' ').replace(/^@/, '');
    const action: TurnAction = {action: command};
    if (reference.startsWith('ev_')) {
        action.requestId = reference;
    } else if (reference) {
        const queue = await client.turnQueue(roomId, credential);
        const matches = [...new Set(queue.entries.filter((entry) => entry.participantId === reference || entry.name.toLowerCase() === reference.toLowerCase()).map((entry) => entry.participantId))];
        if (matches.length !== 1) {
            throw new Error(matches.length ? 'Several agents share that name; use the request ID from /turns.' : 'No queued turn matches that agent.');
        }
        action.participantId = matches[0]!;
    }
    return client.controlTurn(roomId, owner, action);
}

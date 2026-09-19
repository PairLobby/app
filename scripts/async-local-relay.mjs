// Test-only JSON-lines controller for an isolated real PairLobby relay.
import {createInterface} from 'node:readline';
import {startServer} from '@pairlobby/local-server';
import {PairLobbyClient} from '@pairlobby/client';

const server = await startServer({host: '127.0.0.1', port: 0, dataFile: process.argv[2]});
const client = new PairLobbyClient(server.url);
const host = await client.createRoom('Local async test', {displayName: 'Test host', kind: 'human'});
const agent = await client.redeemInvite(host.invite.code, {displayName: 'Test runtime', kind: 'agent'});
const room = host.roomId;
const credential = agent.participantCredential;

async function execute(command) {
    switch (command.operation) {
        case 'send':
            return client.send(room, host.participantCredential, {
                type: 'message',
                recipientId: command.broadcast ? undefined : agent.participantId,
                payload: {text: command.text, priority: 'normal'},
                idempotencyKey: command.key
            });
        case 'pending':
            return client.pendingRequests(room, credential, agent.participantId);
        case 'request':
            return client.request(room, credential, command.eventId);
        case 'ack':
            await client.acknowledgeMessage(room, credential, command.eventId);
            return {ok: true};
        case 'reply':
            return client.reply(room, credential, command.eventId, command.text);
        case 'events':
            return client.readEvents(room, credential, 0);
        default:
            throw new Error('Unknown test operation');
    }
}

console.log(JSON.stringify({ready: true}));
try {
    for await (const line of createInterface({input: process.stdin})) {
        try {
            const result = await execute(JSON.parse(line));
            console.log(JSON.stringify({result}));
        } catch (error) {
            console.log(JSON.stringify({error: error.message}));
        }
    }
} finally {
    await server.close();
}

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {LocalStore} from '@pairlobby/client';
import {select, UsageError} from './context.js';

/** Scoped acknowledgement and pass tools, without notifications or inbox polling. */
export async function runReceiverTools(store: LocalStore, roomRef: string, sessionRef: string, eventId: string): Promise<number> {
    const {room, session, credential, client} = select(store, roomRef, sessionRef);
    if (session.kind !== 'agent' || session.role === 'guest' || !/^ev_[A-Z0-9]+$/.test(eventId)) {
        throw new UsageError('Receiver tools require an agent request');
    }
    const directory = join(store.directory, 'receivers', session.sessionId);
    const database = new DatabaseSync(join(directory, 'inbox.sqlite'));
    database.exec('PRAGMA busy_timeout=5000');
    const server = new Server({name: 'pairlobby-receiver', version: '0.2.0'}, {capabilities: {tools: {}}});
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [{
        name: 'acknowledge_message',
        description: 'Explicitly confirm you have read the current PairLobby request. Automatic transport receipt is separate. The final answer is sent by the receiver.',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false}
    }, {
        name: 'working_message',
        description: 'Declare that you have started working on the current answer, after acknowledging it. The receiver keeps this status alive while your turn runs.',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false}
    }, {
        name: 'message_status',
        description: 'Declare waiting (with dependency), no_action, or declined with a reason. For no_action/declined, end the turn; no extra answer is posted.',
        inputSchema: {type: 'object', properties: {state: {type: 'string', enum: ['waiting', 'no_action', 'declined']}, reason: {type: 'string', minLength: 1, maxLength: 1024}}, required: ['state', 'reason'], additionalProperties: false}
    }, {
        name: 'pass_message',
        description: 'Pass the current speaking turn when you have nothing to add. End your turn after this; no public answer is posted.',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false}
    }]}));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            if (!['acknowledge_message', 'working_message', 'pass_message', 'message_status'].includes(request.params.name) || (request.params.name !== 'message_status' && Object.keys(request.params.arguments ?? {}).length)) {
                throw new Error('Only the current request can be acknowledged');
            }
            const pid = Number(readFileSync(join(directory, 'owner.lock'), 'utf8'));
            if (!Number.isSafeInteger(pid) || pid <= 0) {
                throw new Error('The owning receiver is unavailable');
            }
            process.kill(pid, 0);
            const job = database.prepare('SELECT phase FROM jobs WHERE event_id=?').get(eventId);
            if (job?.['phase'] !== 'running') {
                throw new Error('This request is no longer running');
            }
            const snapshot = await client.snapshot(room.roomId, credential);
            const input = request.params.arguments ?? {};
            if (request.params.name === 'message_status' && (!['waiting', 'no_action', 'declined'].includes(String(input.state)) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1024 || !snapshot.messageStagesSupported)) {
                throw new Error('Choose waiting, no_action or declined with a reason; update the relay if necessary.');
            }
            if (snapshot.messageStagesSupported) {
                await client.reportMessageStatus(room.roomId, credential, eventId, 'read');
            }
            if (request.params.name === 'message_status') {
                const reason = input.reason as string;
                database.prepare('UPDATE jobs SET acknowledged=1 WHERE event_id=?').run(eventId);
                if (input.state === 'waiting') {
                    const token = database.prepare('SELECT value FROM metadata WHERE key=?').get(`turn:${eventId}`)?.['value'];
                    await client.reportMessageStatus(room.roomId, credential, eventId, 'waiting', {reason, ...(typeof token === 'string' ? {turnToken: token} : {})});
                } else {
                    database.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(`decision:${eventId}`, JSON.stringify({state: input.state, reason}));
                }
                return {content: [{type: 'text', text: input.state === 'waiting' ? 'Waiting declared; the task remains open.' : 'Decision recorded. End this turn; no further answer will be posted.'}]};
            }
            if (request.params.name === 'working_message') {
                const token = database.prepare('SELECT value FROM metadata WHERE key=?').get(`turn:${eventId}`)?.['value'];
                if (typeof token !== 'string') {
                    throw new Error('Claim the speaking turn before declaring work');
                }
                await client.declareWorking(room.roomId, credential, eventId, token);
                if (snapshot.messageStagesSupported) {
                    await client.reportMessageStatus(room.roomId, credential, eventId, 'working', {turnToken: token});
                }
                return {content: [{type: 'text', text: 'Working declared. Continue your work and provide the final answer.'}]};
            }
            await client.acknowledgeMessage(room.roomId, credential, eventId);
            database.prepare('UPDATE jobs SET acknowledged=1 WHERE event_id=?').run(eventId);
            if (request.params.name === 'pass_message') {
                if (!database.prepare('SELECT value FROM metadata WHERE key=?').get(`turn:${eventId}`)) {
                    throw new Error('This request has no speaking turn to pass');
                }
                database.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(`pass:${eventId}`, '1');
                return {content: [{type: 'text', text: 'Pass recorded. End your turn now; the receiver will release your slot without posting an answer.'}]};
            }
            return {content: [{type: 'text', text: 'Request acknowledged. Do the authorized work and give your final answer.'}]};
        } catch (error) {
            return {isError: true, content: [{type: 'text', text: error instanceof Error ? error.message : 'Acknowledgement failed'}]};
        }
    });
    const closed = new Promise<void>((resolve) => { server.onclose = resolve; });
    try {
        await server.connect(new StdioServerTransport());
        await closed;
        return 0;
    } finally {
        database.close();
        client.closeLive();
        await server.close();
    }
}

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {LocalStore} from '@pairlobby/client';
import {select, UsageError} from './context.js';

/** One scoped receipt tool, without channel notifications, reminders or inbox polling. */
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
        description: 'Confirm receipt of the current PairLobby request before doing work. The final answer is sent automatically by the receiver.',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false}
    }]}));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            if (request.params.name !== 'acknowledge_message' || Object.keys(request.params.arguments ?? {}).length) {
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
            await client.acknowledgeMessage(room.roomId, credential, eventId);
            database.prepare('UPDATE jobs SET acknowledged=1 WHERE event_id=?').run(eventId);
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

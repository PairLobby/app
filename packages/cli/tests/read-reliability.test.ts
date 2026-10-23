import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {expect, test} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {startServer} from '@pairlobby/local-server';
import {newId} from '@pairlobby/protocol';

test('CLI read acknowledges old outstanding work, and the Stop hook blocks then escalates honestly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-ack-'));
    const relay = await startServer({port: 0, dataFile: join(directory, 'room.sqlite')});
    const client = new PairLobbyClient(relay.url);
    const alice = await client.createRoom('read test', {displayName: 'alice', kind: 'agent'});
    const sessionId = newId('session');
    const bob = await client.redeemInvite(alice.invite.code, {displayName: 'bob', kind: 'agent', sessionId});
    let rejectReceipt = true;
    const proxy = createServer((request, response) => {
        void (async () => {
            if (rejectReceipt && request.url?.endsWith('/ack')) {
                response.writeHead(503, {'content-type': 'application/json'});
                response.end(JSON.stringify({error: {code: 'server_unavailable', message: 'injected receipt failure'}}));
                return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const forwarded = await fetch(relay.url + request.url, {
                method: request.method ?? 'GET',
                headers: {...(request.headers.authorization ? {authorization: request.headers.authorization} : {}), 'content-type': 'application/json'},
                ...(chunks.length ? {body: Buffer.concat(chunks)} : {})
            });
            response.writeHead(forwarded.status, {'content-type': 'application/json'});
            response.end(Buffer.from(await forwarded.arrayBuffer()));
        })().catch(() => {
            response.writeHead(503);
            response.end();
        });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') {
        throw new Error('no proxy port');
    }
    const local = new LocalStore(directory);
    local.upsertRoom({
        roomId: alice.roomId,
        name: 'read test',
        serverUrl: `http://127.0.0.1:${address.port}`,
        createdAt: Date.now(),
        expiresAt: null,
        controls: false,
        sessions: []
    });
    local.addSession(alice.roomId, {
        participantId: bob.participantId,
        sessionId,
        displayName: 'bob',
        kind: 'agent',
        role: 'member',
        joinedAt: Date.now(),
        lastReadSeq: 0,
        cwd: directory
    });
    local.putCredential(alice.roomId, sessionId, bob.participantCredential);
    const ask = await client.send(alice.roomId, alice.participantCredential, {
        type: 'message',
        recipientId: bob.participantId,
        payload: {text: 'old unanswered request', priority: 'normal'},
        idempotencyKey: newId('event')
    });
    async function cli(args: string[], input = '') {
        return new Promise<{code: number | null; stdout: string; stderr: string}>((resolveDone, reject) => {
            const child = spawn(process.execPath, [resolve('packages/cli/dist/main.js'), ...args, '--room', alice.roomId, '--session', sessionId], {
                env: {...process.env, PAIRLOBBY_DATA_DIR: directory},
                stdio: ['pipe', 'pipe', 'pipe']
            });
            let stdout = '',
                stderr = '';
            child.stdout.on('data', (data) => {
                stdout += data;
            });
            child.stderr.on('data', (data) => {
                stderr += data;
            });
            child.on('error', reject);
            child.on('close', (code) => resolveDone({code, stdout, stderr}));
            child.stdin.end(input);
        });
    }
    try {
        const rejected = await cli(['read', '--json']);
        expect(rejected.code).not.toBe(0);
        expect(local.room(alice.roomId)!.sessions[0]!.lastReadSeq).toBe(0);
        expect((await client.request(alice.roomId, alice.participantCredential, ask.event.eventId)).receivedAt).toBeNull();
        rejectReceipt = false;
        local.updateCursor(alice.roomId, sessionId, 999);
        const read = await cli(['read', '--json']);
        expect(read.code, read.stderr).toBe(0);
        expect(JSON.parse(read.stdout).awaitingYourReply[0].eventId).toBe(ask.event.eventId);
        expect((await client.request(alice.roomId, alice.participantCredential, ask.event.eventId)).receivedAt).not.toBeNull();
        const stop = await cli(['guard-stop'], JSON.stringify({stop_hook_active: false}));
        expect(JSON.parse(stop.stdout).decision).toBe('block');
        const repeated = await cli(['guard-stop'], JSON.stringify({stop_hook_active: true}));
        expect(JSON.parse(repeated.stdout).systemMessage).toContain('unanswered');
        const failed = await client.request(alice.roomId, alice.participantCredential, ask.event.eventId);
        expect(failed.failureAt).toBeTruthy();
        expect(failed.responseEventId).toBeNull();
    } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await relay.close();
        rmSync(directory, {recursive: true, force: true});
    }
}, 15_000);

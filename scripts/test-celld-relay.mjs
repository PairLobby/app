#!/usr/bin/env node
// Runs the standalone durable relay under `celld dev` and drives it with the real
// client: create, redeem, send and read; the auto-close alarm; state across a
// restart. Skips when no Celld binary is available (set CELLD_BIN or put celld on PATH).

import {spawn, spawnSync} from 'node:child_process';
import {existsSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {PairLobbyClient} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'packages', 'durable-runtime');
const state = join(project, '.celld');

function findCelld() {
    if (process.env.CELLD_BIN) {
        return existsSync(process.env.CELLD_BIN) ? process.env.CELLD_BIN : null;
    }
    const found = spawnSync('sh', ['-c', 'command -v celld'], {encoding: 'utf8'});
    return found.status === 0 ? found.stdout.trim() : null;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
    console.log(`ok - ${message}`);
}

async function start(celld, port, clean) {
    // Celld bundles with esbuild; Wrangler already installed one.
    const env = {...process.env, CELLD_ESBUILD: process.env.CELLD_ESBUILD ?? join(root, 'node_modules', '.bin', 'esbuild')};
    const child = spawn(celld, ['dev', project, '--port', String(port), '--no-watch', ...(clean ? ['--clean'] : [])], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (child.exitCode !== null) {
            throw new Error(`celld dev exited early:\n${output}`);
        }
        try {
            const response = await fetch(`${base}/health`);
            if (response.ok) {
                return {base, stop: () => stop(child)};
            }
        } catch {}
        await sleep(250);
    }
    child.kill('SIGKILL');
    throw new Error(`celld dev did not become ready:\n${output}`);
}

function stop(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null) {
            resolve();
            return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    });
}

const celld = findCelld();
if (!celld) {
    console.log('skip - no celld binary (set CELLD_BIN or install celld)');
    process.exit(0);
}

const port = await freePort();
let server = await start(celld, port, true);
try {
    const owner = new PairLobbyClient(server.base);
    const guest = new PairLobbyClient(server.base);
    const room = await owner.createRoom('celld', {displayName: 'Ada', kind: 'human'});
    const joined = await guest.redeemInvite(room.invite.code, {displayName: 'claude-backend', kind: 'agent'});
    check(joined.roomId === room.roomId, 'invite redeems into the room that minted it');

    const sent = await owner.send(room.roomId, room.participantCredential, {type: 'message', recipientId: joined.participantId, payload: {text: 'hello over celld', priority: 'normal'}, idempotencyKey: newId('event')});
    const page = await guest.readEvents(joined.roomId, joined.participantCredential, 0);
    check(page.events.some((event) => event.eventId === sent.event.eventId), 'the joined agent reads the message');

    const closing = await owner.createRoom('alarm', {displayName: 'Ada', kind: 'human'});
    await owner.setAutoClose(closing.roomId, closing.controllerCredential, {mode: 'age', afterMs: 1500});
    await sleep(5000);
    const closed = await owner.snapshot(closing.roomId, closing.participantCredential);
    // A lazy close on read would stamp ~5s; only the alarm closes it at its deadline.
    check(closed.lifecycle === 'closed' && closed.closedAt - closed.createdAt < 4000, 'the auto-close alarm closes an untouched room on time');

    await server.stop();
    server = await start(celld, port, false);
    const after = new PairLobbyClient(server.base);
    const restored = await after.readEvents(joined.roomId, joined.participantCredential, 0);
    check(restored.events.some((event) => event.eventId === sent.event.eventId), 'room state survives a celld restart');
} finally {
    await server.stop();
    rmSync(state, {recursive: true, force: true});
}

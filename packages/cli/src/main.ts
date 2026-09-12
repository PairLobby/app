#!/usr/bin/env node
//! The PairLobby command line.
//!
//! Bare `pairlobby` is the human's view of this device: which rooms their agents
//! joined, which session touched which room, and where each one has read to. It
//! prints registry metadata only — credentials live in a separate store, so
//! listing a room can never disclose one.

import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';

import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {ProtocolError, newId} from '@pairlobby/protocol';
import type {AdapterCapabilities} from '@pairlobby/protocol';

import {HANDOVER_TEMPLATE, parseHandoverFile} from './handover-file.js';
import {detectRuntime} from './runtime-detect.js';
import {UsageError, controllerCredential, resolveRecipient, resolveRoom, resolveServer, resolveSession, select} from './context.js';
import {json, note, out, renderEvents, renderRooms, renderSnapshot} from './render.js';

const OPTIONS = {
    name:       {type: 'string'},
    as:         {type: 'string'},
    room:       {type: 'string'},
    session:    {type: 'string'},
    to:         {type: 'string'},
    file:       {type: 'string'},
    server:     {type: 'string'},
    local:      {type: 'boolean'},
    json:       {type: 'boolean'},
    after:      {type: 'string'},
    revision:      {type: 'string'},
    'handover-id': {type: 'string'},
    reason:     {type: 'string'},
    outcome:    {type: 'string'},
    conversation: {type: 'string'},
    follow:     {type: 'boolean'},
    interval:   {type: 'string'},
    runtime:    {type: 'string'},
    human:      {type: 'boolean'},
    template:   {type: 'boolean'},
    host:       {type: 'string'},
    port:       {type: 'string'},
    'data-dir': {type: 'string'},
    help:       {type: 'boolean'},
} as const;

const HELP = `pairlobby — a private room for your agents

  pairlobby                          rooms your agents joined on this device
  pairlobby create --name <name>     start a room and print an invite
  pairlobby join <code>              join a room with an invite code
  pairlobby send <text> --to <who>   send a message to one participant
  pairlobby read                     read new events for this session
  pairlobby watch                    follow the room live as events arrive
  pairlobby session                  this session's id and runtime conversation
  pairlobby handover --to <who> --file <path>
  pairlobby handover --to <who> --file <path> --handover-id <id> --revision <n>
  pairlobby accept <handover-id> --revision <n>
  pairlobby decline <handover-id> --revision <n>
  pairlobby status                   participants and control state
  pairlobby invite                   mint another invite code
  pairlobby ack --outcome <outcome>  report what a pause actually did
  pairlobby pause <who>              controller only
  pairlobby resume <who>             controller only
  pairlobby serve                    run a local room server

Common options
  --room <name|id>      required when this device holds more than one room
  --session <id>        required when one room holds more than one local session
  --server <url>        choose the relay; --local means http://127.0.0.1:8790
  --json                machine-readable output on stdout
  --conversation <id>   the runtime's own conversation id, so a human can find
                        this agent outside the room (auto-detected where possible)

Two agents in one checkout get separate identities. After joining, an agent
should pass --session (or set PAIRLOBBY_SESSION) on every later command.
`;

async function main(argv: string[]): Promise<number> {
    const {values, positionals} = parseArgs({args: argv, options: OPTIONS, allowPositionals: true, strict: true});
    const command = positionals[0] ?? 'rooms';
    if (values.help) {
        out(HELP);
        return 0;
    }
    const store = new LocalStore();

    switch (command) {
        case 'rooms':    return listRooms(store, values);
        case 'create':   return createRoom(store, values);
        case 'join':     return joinRoom(store, values, positionals[1]);
        case 'send':     return sendMessage(store, values, positionals.slice(1).join(' '));
        case 'read':     return readEvents(store, values);
        case 'watch':    return watchRoom(store, values);
        case 'session':  return sessionInfo(store, values);
        case 'status':   return status(store, values);
        case 'invite':   return invite(store, values);
        case 'handover': return offerHandover(store, values);
        case 'accept':   return resolveHandover(store, values, positionals[1], true);
        case 'decline':  return resolveHandover(store, values, positionals[1], false);
        case 'ack':      return acknowledge(store, values);
        case 'pause':    return setPaused(store, values, positionals[1], true);
        case 'resume':   return setPaused(store, values, positionals[1], false);
        case 'close':    return closeRoom(store, values);
        case 'serve':    return serve(values);
        case 'help':     out(HELP); return 0;
        default:         throw new UsageError(`unknown command "${command}"; run "pairlobby help"`);
    }
}

type Values = Partial<Record<keyof typeof OPTIONS, string | boolean>>;

function str(values: Values, key: keyof typeof OPTIONS): string | undefined {
    const value = values[key];
    return typeof value === 'string' ? value : undefined;
}

function flag(values: Values, key: keyof typeof OPTIONS): boolean {
    return values[key] === true;
}

function listRooms(store: LocalStore, values: Values): number {
    const rooms = store.rooms();
    if (flag(values, 'json')) {
        json({rooms});
        return 0;
    }
    renderRooms(rooms);
    return 0;
}

function identityFrom(values: Values, fallbackName: string): {displayName: string; kind: 'agent' | 'human'; sessionId: string; capabilities?: AdapterCapabilities} {
    const detected = detectRuntime();
    const runtime = str(values, 'runtime') ?? detected.runtime;
    const capabilities: AdapterCapabilities | undefined = runtime ? {deliverUnsolicited: false, cancelTurn: false, cancelTool: false, runtime} : undefined;
    return {
        displayName: str(values, 'as') ?? fallbackName,
        kind: flag(values, 'human') ? 'human' : 'agent',
        sessionId: newId('session'),
        ...(capabilities ? {capabilities} : {}),
    };
}

/**
 * Local-only detail about where this session is running. It goes in the device
 * registry and never to the relay: a runtime conversation id is how the owner
 * finds their own agent, not something other participants need.
 */
function localDetail(values: Values): {runtime?: string; conversationId?: string; terminal?: string; pid?: number} {
    const detected = detectRuntime();
    // A conversation id is only inherited when this really is the detected runtime
    // talking. A human, or an agent declaring a different runtime, would otherwise
    // be labelled with whichever session happened to spawn the shell — exactly the
    // confusion the field exists to remove.
    const declared = str(values, 'runtime');
    const detectionApplies = !flag(values, 'human') && (declared === undefined || declared === detected.runtime);
    const conversationId = str(values, 'conversation') ?? (detectionApplies ? detected.conversationId : undefined);
    const runtime = declared ?? (flag(values, 'human') ? undefined : detected.runtime);
    return {...(runtime ? {runtime} : {}), ...(conversationId ? {conversationId} : {}), ...(detected.terminal ? {terminal: detected.terminal} : {}), pid: detected.pid};
}

async function createRoom(store: LocalStore, values: Values): Promise<number> {
    const name = str(values, 'name');
    if (!name) throw new UsageError('pairlobby create needs --name');
    const serverUrl = resolveServer({server: str(values, 'server'), local: flag(values, 'local')});
    const identity = identityFrom(values, 'agent');
    const client = new PairLobbyClient(serverUrl);
    const created = await client.createRoom(name, identity);

    store.upsertRoom({roomId: created.roomId, name, serverUrl, createdAt: created.room.createdAt, expiresAt: created.room.expiresAt, controls: true, sessions: []});
    // The controller credential stays on disk and out of the result an agent sees.
    store.putCredential(created.roomId, 'controller', created.controllerCredential);
    store.putCredential(created.roomId, identity.sessionId, created.participantCredential);
    store.addSession(created.roomId, {participantId: created.participantId, sessionId: identity.sessionId, displayName: identity.displayName, kind: identity.kind, role: 'member', joinedAt: created.room.createdAt, lastReadSeq: 0, cwd: process.cwd(), ...localDetail(values)});

    if (flag(values, 'json')) {
        json({roomId: created.roomId, name, serverUrl, participantId: created.participantId, sessionId: identity.sessionId, invite: created.invite, ...localDetail(values)});
        return 0;
    }
    const detail = localDetail(values);
    out(`Room: ${name}`);
    out(`Invite: ${created.invite.code}  (single use)`);
    out(`Session: ${identity.sessionId}`);
    if (detail.conversationId) out(`Conversation: ${detail.conversationId}`);
    out('');
    out(`  pairlobby join ${created.invite.code} --server ${serverUrl}`);
    note('The controller credential for this room was stored on this device and is not printed.');
    return 0;
}

async function joinRoom(store: LocalStore, values: Values, code?: string): Promise<number> {
    if (!code) throw new UsageError('pairlobby join needs an invite code');
    const serverUrl = resolveServer({server: str(values, 'server'), local: flag(values, 'local')});
    const identity = identityFrom(values, 'agent');
    const client = new PairLobbyClient(serverUrl);
    const joined = await client.redeemInvite(code, identity);

    store.upsertRoom({roomId: joined.roomId, name: joined.room.name, serverUrl, createdAt: joined.room.createdAt, expiresAt: joined.room.expiresAt, controls: store.room(joined.roomId)?.controls ?? false, sessions: store.room(joined.roomId)?.sessions ?? []});
    store.putCredential(joined.roomId, identity.sessionId, joined.participantCredential);
    store.addSession(joined.roomId, {participantId: joined.participantId, sessionId: identity.sessionId, displayName: identity.displayName, kind: identity.kind, role: joined.role, joinedAt: Date.now(), lastReadSeq: 0, cwd: process.cwd(), ...localDetail(values)});

    if (flag(values, 'json')) {
        json({roomId: joined.roomId, name: joined.room.name, serverUrl, participantId: joined.participantId, sessionId: identity.sessionId, role: joined.role, ...localDetail(values), participants: joined.room.participants.map((participant) => ({participantId: participant.participantId, displayName: participant.displayName}))});
        return 0;
    }
    const detail = localDetail(values);
    out(`Joined ${joined.room.name} as ${identity.displayName}`);
    out(`Session: ${identity.sessionId}`);
    if (detail.conversationId) out(`Conversation: ${detail.conversationId}`);
    out('');
    renderSnapshot(joined.room);
    return 0;
}

async function sendMessage(store: LocalStore, values: Values, text: string): Promise<number> {
    if (text.trim().length === 0) throw new UsageError('pairlobby send needs a message');
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const recipient = str(values, 'to');
    const recipientId = recipient ? resolveRecipient((await client.snapshot(room.roomId, credential)).participants, recipient) : undefined;
    // The key is generated once so a retry after a lost response is a replay, not a second message.
    const result = await client.send(room.roomId, credential, {type: 'message', payload: {text, priority: 'normal'}, idempotencyKey: newId('event'), ...(recipientId ? {recipientId} : {})});

    if (flag(values, 'json')) {
        json({seq: result.event.seq, eventId: result.event.eventId, deduplicated: result.deduplicated});
        return 0;
    }
    note(`sent as #${result.event.seq}${recipientId ? ` to ${recipient}` : ' to the room'}`);
    return 0;
}

async function readEvents(store: LocalStore, values: Values): Promise<number> {
    const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const after = str(values, 'after') !== undefined ? Number(str(values, 'after')) : session.lastReadSeq;
    const page = await client.readEvents(room.roomId, credential, after);
    const snapshot = await client.snapshot(room.roomId, credential);
    const names = new Map(snapshot.participants.map((participant) => [participant.participantId, participant.displayName] as const));

    // The cursor advances only on an explicit read, so delivery and consumption stay distinct.
    if (page.events.length > 0) store.updateCursor(room.roomId, session.sessionId, page.events.at(-1)!.seq);

    if (flag(values, 'json')) {
        json({events: page.events, latestSeq: page.latestSeq, hasMore: page.hasMore, addressedToMe: page.events.filter((event) => event.recipientId === session.participantId).map((event) => event.eventId)});
        return 0;
    }
    if (page.events.length === 0) {
        note(`nothing new in ${room.name} since #${after}`);
        return 0;
    }
    renderEvents(page.events, names);
    if (page.hasMore) note(`more events remain; run read again`);
    return 0;
}

/**
 * Follows a room live. This polls, because there is no push channel yet: the
 * relay knows about a new event long before this loop asks for it. A WebSocket
 * is the right fix and is not built; until then the interval is the latency.
 */
async function watchRoom(store: LocalStore, values: Values): Promise<number> {
    const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const intervalMs = str(values, 'interval') !== undefined ? Number(str(values, 'interval')) : 1000;
    const machine = flag(values, 'json');
    let cursor = str(values, 'after') !== undefined ? Number(str(values, 'after')) : 0;

    const snapshot = await client.snapshot(room.roomId, credential);
    const names = new Map(snapshot.participants.map((participant) => [participant.participantId, participant.displayName] as const));
    if (!machine) {
        renderSnapshot(snapshot);
        out('');
        note(`following ${room.name} as ${session.displayName}; Ctrl+C to stop`);
        out('');
    }

    let stopped = false;
    const stop = () => {stopped = true;};
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    while (!stopped) {
        let page;
        try {
            page = await client.readEvents(room.roomId, credential, cursor);
        } catch (error) {
            // A relay that went away should not end the watch; a room that ended should.
            if (error instanceof ProtocolError && (error.code === 'room_expired' || error.code === 'room_closed' || error.code === 'participant_revoked')) throw error;
            if (error instanceof ProtocolError && error.code === 'server_unavailable') {
                note('relay unreachable, retrying');
                await sleep(intervalMs * 2);
                continue;
            }
            throw error;
        }
        if (page.events.length > 0) {
            cursor = page.events.at(-1)!.seq;
            store.updateCursor(room.roomId, session.sessionId, cursor);
            for (const event of page.events) {
                if (event.senderId && !names.has(event.senderId)) {
                    const refreshed = await client.snapshot(room.roomId, credential);
                    for (const participant of refreshed.participants) names.set(participant.participantId, participant.displayName);
                }
            }
            if (machine) for (const event of page.events) process.stdout.write(`${JSON.stringify(event)}\n`);
            else renderEvents(page.events, names);
        }
        if (page.hasMore) continue;
        await sleep(intervalMs);
    }
    return 0;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shows what a human needs to go find this agent outside the room. */
async function sessionInfo(store: LocalStore, values: Values): Promise<number> {
    const room = resolveRoom(store, str(values, 'room'));
    const conversation = str(values, 'conversation');
    if (conversation) {
        const target = resolveSession(room, str(values, 'session'));
        if (!store.setConversation(room.roomId, target.sessionId, conversation)) throw new UsageError('could not update that session');
        out(`Session ${target.sessionId} is conversation ${conversation}`);
        return 0;
    }
    const sessions = str(values, 'session') ? [resolveSession(room, str(values, 'session'))] : room.sessions;
    if (flag(values, 'json')) {
        json({roomId: room.roomId, name: room.name, sessions});
        return 0;
    }
    for (const entry of sessions) {
        out(`${entry.displayName}  ${entry.sessionId}`);
        out(`  participant   ${entry.participantId}`);
        out(`  runtime       ${entry.runtime ?? 'unreported'}`);
        out(`  conversation  ${entry.conversationId ?? 'unknown — pairlobby session --session ' + entry.sessionId + ' --conversation <id>'}`);
        if (entry.terminal) out(`  terminal      ${entry.terminal}`);
        if (entry.pid) out(`  invoked by pid ${entry.pid}`);
        out(`  cwd           ${entry.cwd}`);
    }
    return 0;
}

async function status(store: LocalStore, values: Values): Promise<number> {
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const snapshot = await client.snapshot(room.roomId, credential);
    if (flag(values, 'json')) {
        json(snapshot);
        return 0;
    }
    renderSnapshot(snapshot);
    return 0;
}

async function invite(store: LocalStore, values: Values): Promise<number> {
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const minted = await client.mintInvite(room.roomId, credential);
    if (flag(values, 'json')) {
        json(minted);
        return 0;
    }
    out(minted.code);
    note(`single use, expires ${new Date(minted.expiresAt).toISOString()}`);
    return 0;
}

async function offerHandover(store: LocalStore, values: Values): Promise<number> {
    if (flag(values, 'template')) {
        out(HANDOVER_TEMPLATE);
        return 0;
    }
    const file = str(values, 'file');
    const recipient = str(values, 'to');
    if (!file) throw new UsageError('pairlobby handover needs --file (or --template to print a starting point)');
    if (!recipient) throw new UsageError('pairlobby handover needs --to');
    const document = parseHandoverFile(readFileSync(file, 'utf8'));
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const recipientId = resolveRecipient((await client.snapshot(room.roomId, credential)).participants, recipient);

    // An amendment reuses the id and takes the next revision; a new offer starts at 1.
    const revision = str(values, 'revision') !== undefined ? Number(str(values, 'revision')) : 1;
    const existingId = str(values, 'handover-id');
    if (revision > 1 && !existingId) throw new UsageError('amending a handover needs --handover-id naming the handover being revised');
    const handoverId = existingId ?? newId('handover');
    const result = await client.send(room.roomId, credential, {type: 'handover.offered', payload: {handoverId, revision, document}, idempotencyKey: newId('event'), recipientId});

    if (flag(values, 'json')) {
        json({handoverId, revision, seq: result.event.seq, recipientId});
        return 0;
    }
    out(`Offered handover ${handoverId} revision ${revision} to ${recipient}`);
    note(`the recipient accepts with: pairlobby accept ${handoverId} --revision ${revision}`);
    return 0;
}

async function resolveHandover(store: LocalStore, values: Values, handoverId: string | undefined, accept: boolean): Promise<number> {
    if (!handoverId) throw new UsageError(`pairlobby ${accept ? 'accept' : 'decline'} needs a handover id`);
    const revisionText = str(values, 'revision');
    if (!revisionText) throw new UsageError('pass --revision with the exact revision you read, so a newer one is never accepted by accident');
    const revision = Number(revisionText);
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const reason = str(values, 'reason');
    const payload = accept ? {handoverId, revision} : {handoverId, revision, ...(reason ? {reason} : {})};
    const result = await client.send(room.roomId, credential, {type: accept ? 'handover.accepted' : 'handover.declined', payload, idempotencyKey: newId('event')} as never);

    if (flag(values, 'json')) {
        json({handoverId, revision, accepted: accept, seq: result.event.seq});
        return 0;
    }
    out(`${accept ? 'Accepted' : 'Declined'} handover ${handoverId} revision ${revision}`);
    if (accept) note('acceptance confirms receipt and responsibility; it is not a filesystem lock');
    return 0;
}

const OUTCOMES = ['paused_between_turns', 'current_turn_cancelled', 'tool_cancellation_unknown', 'resumed', 'unsupported'] as const;

/**
 * Reports what a control request actually achieved. The outcome is the agent's
 * own claim about its runtime, which is why the CLI will not pick one: a wrong
 * answer here tells the human an agent stopped when it did not.
 */
async function acknowledge(store: LocalStore, values: Values): Promise<number> {
    const outcome = str(values, 'outcome');
    if (!outcome || !(OUTCOMES as readonly string[]).includes(outcome)) {
        throw new UsageError(`pairlobby ack needs --outcome, one of: ${OUTCOMES.join(', ')}`);
    }
    const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const snapshot = await client.snapshot(room.roomId, credential);
    const me = snapshot.participants.find((participant) => participant.participantId === session.participantId);
    if (!me) throw new UsageError('this session is not a participant of the room any more');
    const revision = str(values, 'revision') !== undefined ? Number(str(values, 'revision')) : me.controlRevision;
    if (revision < 1) throw new UsageError('there is no control request outstanding for this session');

    const result = await client.send(room.roomId, credential, {type: 'control.ack', payload: {targetParticipantId: session.participantId, revision, outcome: outcome as never}, idempotencyKey: newId('event')});
    if (flag(values, 'json')) {
        json({revision, outcome, seq: result.event.seq});
        return 0;
    }
    out(`Acknowledged control revision ${revision}: ${outcome}`);
    return 0;
}

async function setPaused(store: LocalStore, values: Values, target: string | undefined, paused: boolean): Promise<number> {
    if (!target) throw new UsageError(`pairlobby ${paused ? 'pause' : 'resume'} needs a participant`);
    const room = resolveRoom(store, str(values, 'room'));
    const credential = controllerCredential(store, room);
    const client = new PairLobbyClient(room.serverUrl);
    const snapshot = await client.snapshot(room.roomId, credential);
    const targetId = resolveRecipient(snapshot.participants, target);
    const result = await client.control(room.roomId, credential, targetId, paused);

    if (flag(values, 'json')) {
        json({revision: result.revision, targetParticipantId: targetId, paused});
        return 0;
    }
    out(`${paused ? 'Pause' : 'Resume'} requested for ${target}, revision ${result.revision}`);
    // The request is recorded; what actually happened is whatever the adapter acknowledges.
    note('this is a request, not a confirmation — run "pairlobby status" to see what the adapter acknowledged');
    return 0;
}

async function closeRoom(store: LocalStore, values: Values): Promise<number> {
    const room = resolveRoom(store, str(values, 'room'));
    const credential = controllerCredential(store, room);
    await new PairLobbyClient(room.serverUrl).close(room.roomId, credential);
    if (flag(values, 'json')) {
        json({roomId: room.roomId, closed: true});
        return 0;
    }
    out(`Closed ${room.name}. History stays readable and exportable for 24 hours.`);
    return 0;
}

async function serve(values: Values): Promise<number> {
    const {startServer} = await import('@pairlobby/local-server');
    const {dataDirectory} = await import('@pairlobby/client');
    const {join} = await import('node:path');
    const dataDir = str(values, 'data-dir') ?? dataDirectory();
    const running = await startServer({
        host: str(values, 'host') ?? '127.0.0.1',
        port: str(values, 'port') !== undefined ? Number(str(values, 'port')) : 8790,
        dataFile: join(dataDir, 'rooms.sqlite'),
    });
    out(`PairLobby server on ${running.url}`);
    out(`Data: ${running.dataFile}`);
    out('Press Ctrl+C to stop.');
    // Runs in the foreground: an auto-starting daemon is lifecycle complexity nobody has asked for yet.
    await new Promise<void>((resolve) => {
        const stop = () => {void running.close().then(resolve);};
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
    return 0;
}

void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
}).catch((error: unknown) => {
    if (error instanceof UsageError) {
        note(String(error.message));
        process.exitCode = 2;
        return;
    }
    if (error instanceof ProtocolError) {
        note(`${error.code}: ${error.message}`);
        process.exitCode = 1;
        return;
    }
    note(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});

export {main};

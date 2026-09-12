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
import {runChatRoom} from './chat.js';
import {UsageError, controllerCredential, resolveRecipient, resolveRoom, resolveServer, resolveSession, select} from './context.js';
import {json, note, out, renderEvents, renderRoomList, renderRooms, renderSnapshot, renderWatchHeader} from './render.js';

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
    'no-follow': {type: 'boolean'},
    agent:      {type: 'boolean'},
    clear:      {type: 'boolean'},
    force:      {type: 'boolean'},
    reset:      {type: 'boolean'},
    once:       {type: 'boolean'},
    interval:   {type: 'string'},
    wait:       {type: 'string'},
    all:        {type: 'boolean'},
    runtime:    {type: 'string'},
    human:      {type: 'boolean'},
    template:   {type: 'boolean'},
    host:       {type: 'string'},
    port:       {type: 'string'},
    'data-dir': {type: 'string'},
    help:       {type: 'boolean'},
} as const;

const HELP = `pairlobby — a private room for your agents

  pairlobby, pairlobby list          rooms on this device, with live participant counts
  pairlobby name <room> <new name>   rename a room (controller only)
  pairlobby delete <room>            delete a room (controller only)
  pairlobby forget <room>            drop the local record, leave the server alone
  pairlobby settings                 show or change preferences
  pairlobby create --name <name>     start a room and print an invite
  pairlobby join <code>              join a room and enter it
  pairlobby chat                     re-enter a room you already joined
  pairlobby send <text> --to <who>   send a message to one participant
  pairlobby read                     read new events for this session
  pairlobby read --wait 300          block until something is addressed to you
  pairlobby watch                    follow the room live as events arrive
  pairlobby session                  this session's id and runtime conversation
  pairlobby profile --as <name> --human
                                     set defaults so plain "join <code>" works
  pairlobby handover --to <who> --file <path>
  pairlobby handover --to <who> --file <path> --handover-id <id> --revision <n>
  pairlobby accept <handover-id> --revision <n>
  pairlobby decline <handover-id> --revision <n>
  pairlobby status                   participants and control state
  pairlobby invite                   mint an invite code (a reusable seat; --once for single use)
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
        case 'rooms':
        case 'list':     return listRooms(store, values);
        case 'name':     return renameRoom(store, values, positionals[1], positionals.slice(2).join(' '));
        case 'delete':   return deleteRoom(store, values, positionals[1]);
        case 'create':   return createRoom(store, values);
        case 'join':     return joinRoom(store, values, positionals[1]);
        case 'send':     return sendMessage(store, values, positionals.slice(1).join(' '));
        case 'read':     return readEvents(store, values);
        case 'watch':    return watchRoom(store, values);
        case 'chat':     return chatRoom(store, values);
        case 'session':  return sessionInfo(store, values);
        case 'profile':  return profileCommand(store, values);
        case 'settings': return settingsCommand(store, values, positionals[1], positionals[2]);
        case 'forget':   return forgetRoom(store, values, positionals[1]);
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

/**
 * Lists rooms with live counts. Each room is asked its own server, so a room on
 * an unreachable relay is reported as unreachable rather than silently shown
 * with stale local numbers.
 */
async function listRooms(store: LocalStore, values: Values): Promise<number> {
    const rooms = store.rooms();
    const detailed = await Promise.all(rooms.map(async (room) => {
        const credential = store.credential(room.roomId, 'controller') ?? room.sessions.map((session) => store.credential(room.roomId, session.sessionId)).find(Boolean);
        if (!credential) return {room, reachable: false as const};
        try {
            return {room, reachable: true as const, snapshot: await new PairLobbyClient(room.serverUrl).snapshot(room.roomId, credential)};
        } catch (error) {
            return {room, reachable: false as const, why: error instanceof ProtocolError ? error.code : 'unreachable'};
        }
    }));

    if (flag(values, 'json')) {
        json({count: rooms.length, rooms: detailed.map((entry) => ({...entry.room, live: 'snapshot' in entry ? entry.snapshot : null}))});
        return 0;
    }
    renderRoomList(detailed);
    return 0;
}

async function renameRoom(store: LocalStore, values: Values, reference: string | undefined, name: string): Promise<number> {
    if (!reference) throw new UsageError('pairlobby name needs a room and a new name');
    const room = resolveRoom(store, reference);
    if (name.trim().length === 0) throw new UsageError(`pairlobby name ${reference} <new name>`);
    const credential = controllerCredential(store, room);
    await new PairLobbyClient(room.serverUrl).rename(room.roomId, credential, name.trim());
    store.upsertRoom({...room, name: name.trim()});

    if (flag(values, 'json')) {
        json({roomId: room.roomId, name: name.trim(), previousName: room.name});
        return 0;
    }
    out(`${room.name} is now ${name.trim()}`);
    return 0;
}

/**
 * Deletes a room. The server makes it inaccessible immediately; physical cleanup
 * may lag, which is why the local registry entry goes at the same time rather
 * than waiting for a later confirmation.
 */
async function deleteRoom(store: LocalStore, values: Values, reference: string | undefined): Promise<number> {
    if (!reference) throw new UsageError('pairlobby delete needs a room');
    const room = resolveRoom(store, reference);
    const credential = controllerCredential(store, room);
    const confirm = store.settings().confirmDelete && !flag(values, 'force') && !flag(values, 'json') && process.stdin.isTTY;
    if (confirm) {
        const {createInterface} = await import('node:readline/promises');
        const terminal = createInterface({input: process.stdin, output: process.stdout});
        const answer = await terminal.question(`Delete ${room.name} (${room.roomId}) and its history? This cannot be undone. [y/N] `);
        terminal.close();
        if (answer.trim().toLowerCase() !== 'y') {
            note('left alone');
            return 0;
        }
    }
    try {
        await new PairLobbyClient(room.serverUrl).delete(room.roomId, credential);
    } catch (error) {
        // A dead relay must not strand the entry forever. Deleting needs the server
        // to answer; dropping the local record does not, so say which is which.
        if (error instanceof ProtocolError && error.code === 'server_unavailable') {
            throw new UsageError(`could not reach ${room.serverUrl}, so the room was not deleted.\n  Start the server and try again, or drop this device's record of it:\n    pairlobby forget ${room.roomId}`);
        }
        if (error instanceof ProtocolError && (error.code === 'room_not_found' || error.code === 'room_expired')) {
            store.forgetRoom(room.roomId);
            out(`${room.name} was already gone; removed it from this device.`);
            return 0;
        }
        throw error;
    }
    store.forgetRoom(room.roomId);

    if (flag(values, 'json')) {
        json({roomId: room.roomId, deleted: true});
        return 0;
    }
    out(`Deleted ${room.name}`);
    return 0;
}

/**
 * Resolves who is joining: explicit flags first, then the device profile, then
 * what the environment reveals.
 *
 * The profile is deliberately ignored when a runtime is detected and the profile
 * is a human's. Otherwise an agent running `pairlobby join` in a shell its owner
 * configured would join wearing the owner's name and human role — quietly
 * granting itself an identity the room has no other way to question.
 */
function identityFrom(store: LocalStore, values: Values, fallbackName: string): {displayName: string; kind: 'agent' | 'human'; sessionId: string; capabilities?: AdapterCapabilities} {
    const detected = detectRuntime();
    const profile = store.profile();
    const profileApplies = !(detected.runtime !== undefined && profile.kind === 'human');

    const kind = flag(values, 'human') ? 'human' : flag(values, 'agent') ? 'agent' : (profileApplies && profile.kind) || (detected.runtime ? 'agent' : 'agent');
    const displayName = str(values, 'as') ?? (profileApplies ? profile.displayName : undefined) ?? fallbackName;
    const runtime = str(values, 'runtime') ?? (kind === 'human' ? undefined : profile.runtime ?? detected.runtime);
    const capabilities: AdapterCapabilities | undefined = runtime ? {deliverUnsolicited: false, cancelTurn: false, cancelTool: false, runtime} : undefined;
    return {displayName, kind, sessionId: newId('session'), ...(capabilities ? {capabilities} : {})};
}

const SETTING_KEYS = {
    'confirm-delete': {field: 'confirmDelete', kind: 'boolean', help: 'ask before deleting a room'},
    'poll-interval':  {field: 'pollIntervalMs', kind: 'number', help: 'milliseconds between live-room polls'},
    'show-ids':       {field: 'showIds', kind: 'boolean', help: 'print ids next to names in the live room'},
} as const;

function settingsCommand(store: LocalStore, values: Values, key?: string, value?: string): number {
    if (flag(values, 'reset')) {
        store.resetSettings();
        note('settings reset to defaults');
        return 0;
    }
    if (key !== undefined) {
        const definition = SETTING_KEYS[key as keyof typeof SETTING_KEYS];
        if (!definition) throw new UsageError(`unknown setting "${key}"; known settings: ${Object.keys(SETTING_KEYS).join(', ')}`);
        if (value === undefined) throw new UsageError(`pairlobby settings ${key} <value>`);
        const parsed = definition.kind === 'boolean' ? parseBoolean(key, value) : parseCount(key, value);
        store.setSettings({[definition.field]: parsed} as never);
        note(`${key} is now ${parsed}`);
        return 0;
    }
    const settings = store.settings();
    if (flag(values, 'json')) {
        json(settings);
        return 0;
    }
    const width = Math.max(...Object.keys(SETTING_KEYS).map((name) => name.length));
    for (const [name, definition] of Object.entries(SETTING_KEYS)) {
        out(`${name.padEnd(width)}  ${String(settings[definition.field])}`);
        out(`${' '.repeat(width)}  ${definition.help}`);
    }
    out('');
    note('pairlobby settings <name> <value>   ·   pairlobby settings --reset');
    return 0;
}

function parseBoolean(key: string, value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
    if (['false', 'no', 'off', '0'].includes(normalized)) return false;
    throw new UsageError(`${key} takes true or false, not "${value}"`);
}

function parseCount(key: string, value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${key} takes a positive number, not "${value}"`);
    return parsed;
}

/**
 * Drops a room from this device without touching the server. The room may still
 * exist and other participants are unaffected — this is how you get rid of a
 * record for a relay that is gone, which `delete` cannot do because `delete`
 * needs the server to answer.
 */
function forgetRoom(store: LocalStore, values: Values, reference: string | undefined): number {
    if (!reference) throw new UsageError('pairlobby forget needs a room');
    const room = resolveRoom(store, reference);
    store.forgetRoom(room.roomId);
    if (flag(values, 'json')) {
        json({roomId: room.roomId, forgotten: true});
        return 0;
    }
    out(`Forgot ${room.name} on this device.`);
    note('the room itself is untouched; it expires on its own schedule');
    return 0;
}

/** Shows or sets this device's default identity. */
function profileCommand(store: LocalStore, values: Values): number {
    if (flag(values, 'clear')) {
        store.clearProfile();
        note('profile cleared');
        return 0;
    }
    const update = {
        ...(str(values, 'as') !== undefined ? {displayName: str(values, 'as')!} : {}),
        ...(flag(values, 'human') ? {kind: 'human' as const} : flag(values, 'agent') ? {kind: 'agent' as const} : {}),
        ...(str(values, 'runtime') !== undefined ? {runtime: str(values, 'runtime')!} : {}),
        ...(str(values, 'server') !== undefined ? {server: str(values, 'server')!} : {}),
    };
    const profile = Object.keys(update).length > 0 ? store.setProfile(update) : store.profile();

    if (flag(values, 'json')) {
        json(profile);
        return 0;
    }
    if (Object.keys(profile).length === 0) {
        out('No profile set on this device.');
        out('');
        out('  pairlobby profile --as hugo --human      then plain "pairlobby join <code>" works');
        return 0;
    }
    out(`name     ${profile.displayName ?? '(unset)'}`);
    out(`kind     ${profile.kind ?? '(unset)'}`);
    if (profile.runtime) out(`runtime  ${profile.runtime}`);
    if (profile.server) out(`server   ${profile.server}`);
    if (profile.kind === 'human') note('a detected agent runtime ignores this profile, so agents never join as you');
    return 0;
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
    const serverUrl = resolveServer({server: str(values, 'server') ?? store.profile().server, local: flag(values, 'local')});
    const identity = identityFrom(store, values, 'agent');
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
    const serverUrl = resolveServer({server: str(values, 'server') ?? store.profile().server, local: flag(values, 'local')});
    const identity = identityFrom(store, values, 'agent');
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
    // Joining a room means being in it. Only a machine caller — --json, a pipe,
    // or an explicit --no-follow — gets a printed snapshot and its prompt back.
    if (isInteractive(values)) {
        note(`joined ${joined.room.name} as ${identity.displayName}`);
        return chatRoom(store, {...values, room: joined.roomId, session: identity.sessionId});
    }
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
    const waitSeconds = str(values, 'wait') !== undefined ? Number(str(values, 'wait')) : 0;
    const page = waitSeconds > 0
        ? await waitForEvents(client, room.roomId, credential, session.participantId, after, waitSeconds, flag(values, 'all'), store.settings().pollIntervalMs)
        : await client.readEvents(room.roomId, credential, after);
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

function isInteractive(values: Values): boolean {
    return !flag(values, 'json') && !flag(values, 'no-follow') && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Enters a room already joined on this device. */
async function chatRoom(store: LocalStore, values: Values): Promise<number> {
    const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    if (!isInteractive(values)) return watchRoom(store, values);
    return runChatRoom({
        store,
        client,
        roomId: room.roomId,
        credential,
        sessionId: session.sessionId,
        participantId: session.participantId,
        controllerCredential: store.credential(room.roomId, 'controller'),
        intervalMs: str(values, 'interval') !== undefined ? Number(str(values, 'interval')) : store.settings().pollIntervalMs,
        showIds: store.settings().showIds,
        fromStart: true,
    });
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
        renderWatchHeader(snapshot, session.participantId, session.sessionId);
        note('live; Ctrl+C to leave');
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

/**
 * Blocks until something arrives, so an agent can wait for work instead of
 * polling in a loop and burning a turn on every empty check.
 *
 * By default it returns only when an event is addressed to this participant.
 * Room-wide chatter is not a reason to wake an agent up; --all says otherwise.
 * It returns empty on timeout rather than erroring, so a caller can simply wait
 * again.
 */
async function waitForEvents(client: PairLobbyClient, roomId: string, credential: string, participantId: string, after: number, seconds: number, wakeOnAnything: boolean, intervalMs: number) {
    const deadline = Date.now() + seconds * 1000;
    let cursor = after;
    let latest = after;
    const collected: Awaited<ReturnType<PairLobbyClient['readEvents']>>['events'] = [];

    for (;;) {
        const page = await client.readEvents(roomId, credential, cursor);
        if (page.events.length > 0) {
            cursor = page.events.at(-1)!.seq;
            collected.push(...page.events);
            const wakes = wakeOnAnything
                ? page.events.some((event) => event.senderId !== participantId)
                : page.events.some((event) => event.recipientId === participantId && event.senderId !== participantId);
            if (wakes) return {events: collected, earliestSeq: 0, latestSeq: page.latestSeq, hasMore: page.hasMore};
        }
        latest = page.latestSeq;
        if (Date.now() >= deadline) return {events: collected, earliestSeq: 0, latestSeq: latest, hasMore: false};
        await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    }
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
    const minted = await client.mintInvite(room.roomId, credential, 'member', !flag(values, 'once'));
    if (flag(values, 'json')) {
        json(minted);
        return 0;
    }
    out(minted.code);
    note(minted.reusable
        ? `holds one seat: reusable whenever nobody is in the room under it. Must first be used before ${new Date(minted.expiresAt).toLocaleTimeString()}`
        : `single use, expires ${new Date(minted.expiresAt).toLocaleTimeString()}`);
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
    const host = str(values, 'host') ?? '127.0.0.1';
    const port = str(values, 'port') !== undefined ? Number(str(values, 'port')) : 8790;
    let running;
    try {
        running = await startServer({host, port, dataFile: join(dataDir, 'rooms.sqlite')});
    } catch (error) {
        // Say what is wrong and what to do, rather than surfacing a raw errno. The
        // occupant is never probed: something else owning the port is not ours to poke.
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            throw new UsageError(`something is already listening on ${host}:${port}.\n  If it is your own PairLobby server, you do not need another one.\n  Otherwise pick a different port: pairlobby serve --port ${port + 1}`);
        }
        if ((error as NodeJS.ErrnoException).code === 'EACCES') throw new UsageError(`not allowed to listen on ${host}:${port}; ports below 1024 usually need elevated permissions`);
        throw error;
    }
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

#!/usr/bin/env node
//! The PairLobby command line.
//!
//! Bare `pairlobby` is the human's view of this device: which rooms their agents
//! joined, which session touched which room, and where each one has read to. It
//! prints registry metadata only — credentials live in a separate store, so
//! listing a room can never disclose one.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {userInfo} from 'node:os';
import {parseArgs} from 'node:util';

import {LocalStore, PairLobbyClient, openRequests, owedByMe, unreceipted} from '@pairlobby/client';
import type {JoinedRoom, Settings} from '@pairlobby/client';
import {ParticipantName, ProtocolError, requestState, newId, normalizeInviteCode, MessageAction} from '@pairlobby/protocol';
import type {AdapterCapabilities} from '@pairlobby/protocol';

import {HANDOVER_TEMPLATE, parseHandoverFile} from './handover-file.js';
import {detectRuntime, sameRuntime} from './runtime-detect.js';
import {runChatRoom} from './chat.js';
import {chooseHumanSession, selectHumanSession} from './human-session.js';
import {WhenError, formatDuration, parseDuration, parseExpiry} from './when.js';
import {pickExpiry} from './picker.js';
import {DEFAULT_LOCAL_SERVER, DEFAULT_RELAY_PORT, UsageError, controllerCredential, resolveRecipient, resolveRoom, resolveServer, resolveSession, select} from './context.js';
import {json, note, out, renderEvents, renderOpenRequests, renderRoomList, renderRooms, renderSnapshot, renderWatchHeader} from './render.js';

import {acceptInvitation, accountToken, declineInvitation, isOnlineKey, loginOnline, logoutOnline, matchInvitation, matchOnlineRoom, onlineAccount, onlineOrigin, onlineRooms, receivedInvitations, resolveOnlineKey, setHandle} from './online.js';
import type {ReceivedInvitation} from './online.js';
import {receiverStatus, runReceiver, startReceiver, stopReceiver} from './receiver.js';
import type {ReceiverStatus} from './receiver.js';
import {receiverRuntimeName} from './receiver-runtime.js';
import {discoverableNote, joinCommand, localOnlyNote, parseJoinLink, shareTarget} from './share.js';
import {invitationNotice, rememberInvitations, scheduleInvitationCheck} from './invitation-notice.js';
import {DEFAULT_LOCAL_ROOMS, findLocalRoom, findRelayForInvite, listLocalRooms} from './relay-discovery.js';
import {routeForRoom} from './mentions.js';
import type {RoutedChatMessage} from './mentions.js';
import {tailscaleNames, tailscaleView} from './tailscale.js';
import {VERSION} from './version.js';
import {NETWORK_SHARING_RESTART, SETTING_KEYS, describeSettingValue, parseLifetime, parseSettingValue} from './device-settings.js';
import {applyAutoCloseToRooms, parseAutoClose, summarizeBulk} from './auto-close.js';
import {runSettingsMenu} from './settings-menu.js';
import {checkForUpdate, installRelease, managedInstall, runBackgroundUpdate, scheduleBackgroundCheck, shouldOfferUpdate, updateNotice, writeUpdateState} from './updater.js';
import type {LatestRelease} from './updater.js';
import {findRooms, formatFoundRooms} from './find.js';
import {formatTurnQueue, runTurnCommand} from './turn-commands.js';
import {spawnAgent, formatSpawnResult} from './spawn-agent.js';
import {parseSpawnOptions, SPAWN_HELP} from './spawn-options.js';
import {RoomBrowser} from './room-browser.js';
import type {RoomBrowserOptions} from './room-browser.js';
import {ROOM_COLUMNS, loadRoomList, roomListJson, roomRows, sortListRows} from './room-list.js';
import {waitForReply} from './reply-wait.js';
import {suspendedReplyParents} from './reply-watches.js';

type LocalIdentity = {nameSource: 'room' | 'profile'; displayName: string; kind: 'agent' | 'human'; sessionId: string; capabilities?: AdapterCapabilities};

type LocalRuntimeDetail = {runtime?: string; conversationId?: string; terminal?: string; pid?: number};

const OPTIONS = {
    sort: {type: 'string'},
    desc: {type: 'boolean'},
    'turn-token': {type: 'string'},
    'claim-id': {type: 'string'},
    active: {type: 'boolean'},
    request: {type: 'string'},
    workdir: {type: 'string'},
    version: {type: 'boolean'},
    model: {type: 'string'},
    effort: {type: 'string'},
    resume: {type: 'string'},
    'manual-receive': {type: 'boolean'},
    private: {type: 'boolean'},
    allow: {type: 'string'},
    'skills-dir': {type: 'string'},
    'wait-for-ack': {type: 'string'},
    'no-wait': {type: 'boolean'},
    'allow-from': {type: 'string'},
    'reply-to': {type: 'string'},
    progress: {type: 'boolean'},
    name: {type: 'string'},
    as: {type: 'string'},
    room: {type: 'string'},
    session: {type: 'string'},
    to: {type: 'string'},
    file: {type: 'string'},
    server: {type: 'string'},
    local: {type: 'boolean'},
    json: {type: 'boolean'},
    after: {type: 'string'},
    revision: {type: 'string'},
    'handover-id': {type: 'string'},
    reason: {type: 'string'},
    outcome: {type: 'string'},
    conversation: {type: 'string'},
    follow: {type: 'boolean'},
    'no-follow': {type: 'boolean'},
    agent: {type: 'boolean'},
    clear: {type: 'boolean'},
    force: {type: 'boolean'},
    reset: {type: 'boolean'},
    once: {type: 'boolean'},
    off: {type: 'boolean'},
    expiry: {type: 'string'},
    'expires-in': {type: 'string'},
    interval: {type: 'string'},
    wait: {type: 'string'},
    all: {type: 'boolean'},
    runtime: {type: 'string'},
    human: {type: 'boolean'},
    template: {type: 'boolean'},
    host: {type: 'string'},
    lan: {type: 'boolean'},
    tailscale: {type: 'boolean'},
    username: {type: 'string'},
    'open-local': {type: 'boolean'},
    token: {type: 'boolean'},
    yes: {type: 'boolean'},
    'apply-existing': {type: 'boolean'},
    public: {type: 'boolean'},
    check: {type: 'boolean'},
    background: {type: 'boolean'},
    'no-browser': {type: 'boolean'},
    'public-url': {type: 'string'},
    port: {type: 'string'},
    'data-dir': {type: 'string'},
    help: {type: 'boolean'}
} as const;

const HELP = `pairlobby

  pairlobby, pairlobby list          interactive room/session table in a terminal; also lists rooms open on your network
  pairlobby list --json              JSON snapshot (no interactive UI)
  pairlobby list --sort name --desc  sort rooms; S or click a header in the table
  pairlobby find [--active] --json   ping known rooms; members, dates and latest message
  pairlobby name <room> <new name>   rename a room (controller only)
  pairlobby rename-self <new name>  rename your selected participant in a room
  pairlobby expiry [room] <when>     never | in 10 hours | at 2026-09-20 18:00
  pairlobby expire [room]            pick expiry from a menu
  pairlobby open <room>              let anyone with the room id join as a guest
  pairlobby open <room> --off        back to invite only
  pairlobby open-local <room>        let anyone on your network or tailnet join by name, as a member (--off to stop)
  pairlobby delete <room>            delete a room (controller only)
  pairlobby forget <room>            drop the local record, leave the server alone
  pairlobby settings                 interactive menu for this device's preferences and new-room defaults
  pairlobby create --name <name>     start a room and print an invite
  pairlobby create --name <name> --open-local
                                    the same, and anyone on your network or tailnet can join by its name
  pairlobby join <code>              join a local room and enter it
  pairlobby join <code>             finds the relay that issued the code: this device, the local network, your tailnet
  pairlobby join <room name>        joins a room opened with --open-local, found the same way (join local <name> if it looks like a code)
  pairlobby join <code> --server laptop
                                    join a room served by another device; a bare name or address means port 8790
  pairlobby join online <key>       join a hosted room without a URL or room ID
  pairlobby join online <room>      join one of your account's rooms from any logged-in device
  pairlobby find online [--json]    list the rooms your account owns, is allowed into, or was invited to
  pairlobby invitations [--json]    invitations to hosted rooms that you have not answered
  pairlobby invitations accept <room>   accept one (a person only), then: pairlobby join online <room>
  pairlobby invitations decline <room>
  pairlobby profile --username <handle>  choose the handle others invite you by: /invite @handle
  pairlobby join <code> --runtime codex|claude|qwen
                                    join as a managed agent; receive automatically
  pairlobby receiver status|start|stop
                                    manage automatic receiving for the selected agent
  pairlobby spawn <claude|codex|qwen> [model] [--name name] [--effort level]
                                    create a new background agent in a saved room
  pairlobby login                    approve this terminal in the browser (--no-browser prints the link)
  pairlobby login --token            paste an account token from the website instead
  pairlobby logout                   revoke this terminal's login and forget it
  pairlobby create online --name X [--private | --public] [--allow email,email]
  pairlobby allow [email ...]       replace the room allowlist (creator retained)
  pairlobby chat                     re-enter a room you already joined
  pairlobby send <text> --to <who>   send a message to one participant
  pairlobby send <text> --to codex,claude   ask several agents; --to all asks all agents
  pairlobby turns [sequential|parallel|skip|cancel]   inspect/control speaking turns
  pairlobby turn claim|renew|pass <request>          cooperative agent turn tools
  pairlobby install-skill <agent>   install instructions for claude, codex, qwen, or all
  pairlobby configure-claude        prepare a scoped Claude channel and Stop hook
  pairlobby reply <event-id> <text>  answer one exact request; --progress keeps it open
  pairlobby receipt <event-id>       explicitly acknowledge delivery
  pairlobby requests                every unanswered request, with overdue status
  pairlobby guard-stop              Claude Stop hook: block until pending requests are answered
  pairlobby read                     read new events for this session
  pairlobby read --wait 300          block until something is addressed to you
  pairlobby watch                    follow the room live as events arrive
  pairlobby wait-reply <delivery-id>  wait for an exact outgoing reply; --wait seconds (default 30)
  pairlobby message-status <id> <read|working|waiting|no-action|declined>
                                    explicitly report your stage; --reason for waiting/decisions
  pairlobby link-answer <request-id> <answer-id>
                                    attach your existing unthreaded answer to its request
  pairlobby session                  this session's id and runtime conversation
  pairlobby profile --as <name> --human
                                     set defaults so plain "join <code>" works
  pairlobby handover --to <who> --file <path>
  pairlobby handover --to <who> --file <path> --handover-id <id> --revision <n>
  pairlobby accept <handover-id> --revision <n>
  pairlobby decline <handover-id> --revision <n>
  pairlobby status                   participants and control state
  pairlobby invite                   mint an invite code (a reusable seat; --once for single use)
  pairlobby invite --expires-in 10m  mint one that stops working after a while
  pairlobby ack --outcome <outcome>  report what a pause actually did
  pairlobby interrupt <agent>        stop one agent's current task, hold its queue (owner/admin)
  pairlobby pause <who>              controller only
  pairlobby resume <who>             controller only
  pairlobby serve                    run a local room server (shared as pairlobby settings network-sharing says)
  pairlobby update                   check GitHub for a new release and offer to install it
  pairlobby update --check           only report; --yes installs without asking
  pairlobby serve --tailscale        also accept your Tailscale devices (encrypted by Tailscale)
  pairlobby serve --lan              also accept devices on your network (unencrypted HTTP)
  pairlobby serve --public-url <url> advertise this address in invites (Tailscale, proxy)

Common options
  --room <name|id>      required when this device holds more than one room
  --session <id>        required when one room holds more than one local session
  --server <url>        choose the relay: a URL, or a name or address such as laptop or 10.0.0.5:8791; --local means http://127.0.0.1:8790
  --json                machine-readable output on stdout
  --workdir <directory> project scope when first starting a managed receiver
  --conversation <id>   the runtime's own conversation id, so a human can find
                        this agent outside the room (auto-detected where possible)

Two agents in one checkout get separate identities. After joining, an agent
should pass --session (or set PAIRLOBBY_SESSION) on every later command.
`;

async function main(argv: string[]): Promise<number> {
    const {values, positionals, tokens} = parseArgs({args: argv, options: OPTIONS, allowPositionals: true, strict: true, tokens: true});
    if (positionals[0] === 'spawn') {
        const commandIndex = tokens.find((token) => token.kind === 'positional')!.index;
        const options = parseSpawnOptions(argv.filter((_, index) => index !== commandIndex), true);
        if (options.help) {
            out(SPAWN_HELP);
            return 0;
        }
        const store = new LocalStore();
        const room = resolveRoom(store, options.room);
        const actor = options.session || process.env['PAIRLOBBY_SESSION'] ? select(store, room.roomId, options.session) : await selectHumanSession(store, room);
        const result = await spawnAgent({store, roomId: room.roomId, sessionId: actor.session.sessionId}, options);
        options.json ? json(result) : out(formatSpawnResult(result));
        return 0;
    }
    if (values.version) {
        out(`PairLobby ${VERSION} (automatic Codex, Claude and Qwen receivers)`);
        return 0;
    }
    const command = positionals[0] ?? 'rooms';
    if (values.help) {
        out(HELP);
        return 0;
    }
    const store = new LocalStore();
    scheduleBackgroundCheck(store, command);
    scheduleInvitationCheck(store, command);

    switch (command) {
        case 'receiver-tools':
            return (await import('./receiver-tools.js')).runReceiverTools(store, str(values, 'room')!, str(values, 'session')!, str(values, 'request')!);
        case 'receiver-run':
            return runReceiver(store, str(values, 'room')!, str(values, 'session')!);
        case 'receiver': {
            const {room, session} = select(store, str(values, 'room'), str(values, 'session'));
            const action = positionals[1] ?? 'status';
            if (action === 'start') {
                json(await startReceiver(store, room.roomId, session.sessionId, str(values, 'model'), str(values, 'workdir'), str(values, 'effort')));
            } else if (action === 'stop') {
                await stopReceiver(store, session.sessionId);
                json({state: 'stopped'});
            } else if (action === 'status') {
                json(receiverStatus(store, session.sessionId) ?? {state: 'not-configured'});
            } else {
                throw new UsageError('pairlobby receiver status|start|stop');
            }
            return 0;
        }
        case 'rooms':
        case 'list':
            await offerUpdate(store, values);
            return listRooms(store, values);
        case 'find':
            return positionals[1] === 'online' ? findOnline(store, values) : findCommand(store, values);
        case 'name':
            return renameRoom(store, values, positionals[1], positionals.slice(2).join(' '));
        case 'rename-self':
            return renameSelf(store, values, positionals.slice(1).join(' '));
        case 'expiry':
            return expiryCommand(store, values, positionals.slice(1));
        case 'expire':
            return expireInteractive(store, values, positionals[1]);
        case 'open':
            return setAccess(store, values, positionals[1]);
        case 'open-local':
            return setLocalJoin(store, values, positionals[1]);
        case 'delete':
            return deleteRoom(store, values, positionals[1]);
        case 'create':
            return createRoom(store, values, positionals[1] === 'online');
        case 'join':
            return joinRoom(store, values, ['online', 'local'].includes(positionals[1] ?? '') ? positionals[2] : positionals[1], positionals[1] === 'online', positionals[1] === 'local');
        case 'login':
            out(`Logged in as ${await loginOnline(store, {paste: flag(values, 'token'), ...(flag(values, 'no-browser') ? {openBrowser: false} : {})})}`);
            return 0;
        case 'logout': {
            const result = await logoutOnline(store);
            if (!result.removed) {
                out('No saved account login on this device.');
            } else if (result.revoked) {
                out('Logged out. This terminal\'s token was revoked.');
            } else {
                out('Saved account login removed, but the service did not confirm revoking it; revoke it on the account page.');
            }
            if (process.env['PAIRLOBBY_ACCOUNT_TOKEN']) {
                note('PAIRLOBBY_ACCOUNT_TOKEN is still set in this environment; unset it to stop using that token.');
            }
            return 0;
        }
        case 'allow': {
            const room = resolveRoom(store, str(values, 'room'));
            await new PairLobbyClient(room.serverUrl).setAllowedAccounts(
                room.roomId,
                controllerCredential(store, room),
                positionals
                    .slice(1)
                    .flatMap((value) => value.split(','))
                    .filter(Boolean)
            );
            out('Private room allowed accounts updated; the creator remains allowed.');
            return 0;
        }
        case 'send':
            return sendMessage(store, values, positionals.slice(1).join(' '));
        case 'turns': {
            const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
            const queue = await runTurnCommand(positionals.slice(1).join(' '), {roomId: room.roomId, participantId: session.participantId, credential, client, controllerCredential: store.credential(room.roomId, 'controller')});
            if (flag(values, 'json')) {
                json(queue);
            } else {
                out(formatTurnQueue(queue, true));
            }
            return 0;
        }
        case 'turn': {
            const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
            const action = positionals[1];
            const id = positionals[2];
            if (!id) {
                throw new UsageError('turn requires claim|working|renew|pass and a request ID');
            }
            if (action === 'claim') {
                const claimId = str(values, 'claim-id') ?? newId('event');
                json({claimId, ...await client.claimTurn(room.roomId, credential, id, claimId)});
            } else if ((action === 'renew' || action === 'pass' || action === 'working') && str(values, 'turn-token')) {
                const token = str(values, 'turn-token')!;
                if (action === 'working') {
                    await client.declareWorking(room.roomId, credential, id, token);
                    json({working: id});
                } else if (action === 'renew') {
                    json(await client.renewTurn(room.roomId, credential, id, token));
                } else {
                    await client.passTurn(room.roomId, credential, id, token);
                    json({passed: id});
                }
            } else {
                throw new UsageError('Use turn claim <request>, or turn working|renew|pass <request> --turn-token <token>');
            }
            return 0;
        }
        case 'install-skill': {
            const paths = (await import('./install-skill.js')).installSkill(positionals[1], flag(values, 'force'), str(values, 'skills-dir'));
            if (flag(values, 'json')) {
                json({installed: paths});
            } else {
                for (const path of paths) out(`Installed skill: ${path}`);
            }
            return 0;
        }
        case 'configure-claude': {
            const result = (await import('./channel-config.js')).configureClaude(store, str(values, 'room'), str(values, 'session'), str(values, 'allow-from'));
            json(result);
            return 0;
        }
        case 'channel':
            return (await import('./channel.js')).runChannel(store, str(values, 'room'), str(values, 'session'), str(values, 'allow-from'));
        case 'reply':
            return replyMessage(store, values, positionals[1], positionals.slice(2).join(' '));
        case 'requests':
            return requestStatus(store, values);
        case 'receipt':
            return receiptMessage(store, values, positionals[1]);
        case 'guard-stop':
            return guardStop(store, values);
        case 'read':
            return readEvents(store, values);
        case 'watch':
            return watchRoom(store, values);
        case 'wait-reply':
            return waitReplyCommand(store, values, positionals[1]);
        case 'message-status':
            return messageStatusCommand(store, values, positionals[1], positionals[2]);
        case 'link-answer':
            return messageStatusCommand(store, values, positionals[1], 'done', positionals[2]);
        case 'chat':
            await offerUpdate(store, values);
            return chatRoom(store, values);
        case 'update':
            return updateCommand(store, values);
        case 'session':
            return sessionInfo(store, values);
        case 'profile':
            return profileCommand(store, values);
        case 'invitations':
            return invitationsCommand(store, values, positionals[1], positionals[2]);
        case 'settings':
            return settingsCommand(store, values, positionals[1], positionals[2]);
        case 'forget':
            return forgetRoom(store, values, positionals[1]);
        case 'status':
            return status(store, values);
        case 'invite':
            return invite(store, values);
        case 'handover':
            return offerHandover(store, values);
        case 'accept':
            return resolveHandover(store, values, positionals[1], true);
        case 'decline':
            return resolveHandover(store, values, positionals[1], false);
        case 'ack':
            return acknowledge(store, values);
        case 'interrupt':
            return interruptAgent(store, values, positionals.slice(1).join(' '));
        case 'pause':
            return setPaused(store, values, positionals[1], true);
        case 'resume':
            return setPaused(store, values, positionals[1], false);
        case 'close':
            return closeRoom(store, values);
        case 'serve':
            return serve(store, values);
        case 'help':
            out(HELP);
            return 0;
        default:
            throw new UsageError(`unknown command "${command}"; run "pairlobby help"`);
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
/** Invitations in the room list, for a device that is logged in. The list asks in the background and shows none on any failure. */
function listedInvitations(store: LocalStore): RoomBrowserOptions['invitations'] {
    try {
        if (!accountToken(store)) {
            return undefined;
        }
    } catch {
        return undefined;
    }
    return {
        list: async () => {
            const invitations = await receivedInvitations(store);
            rememberInvitations(store, invitations);
            return invitations;
        },
        decline: (id) => declineInvitation(store, id),
    };
}

/** The room list's search for rooms open on the network, unless the device setting or PAIRLOBBY_NO_NETWORK_SEARCH turns it off. */
function networkRoomSearch(store: LocalStore): RoomBrowserOptions['discover'] {
    if (process.env['PAIRLOBBY_NO_NETWORK_SEARCH'] || !store.settings().networkRooms) {
        return undefined;
    }
    // "This device's relay" is the one its commands use by default, which PAIRLOBBY_SERVER or the profile may name.
    const deps = {...DEFAULT_LOCAL_ROOMS, local: resolveServer({server: store.profile().server})};
    return (known, signal) => listLocalRooms(known, deps, signal);
}

async function listRooms(store: LocalStore, values: Values): Promise<number> {
    const key = str(values, 'sort') ?? 'name';
    if (!ROOM_COLUMNS.some((column) => column.key === key)) {
        throw new UsageError(`Unknown sort column. Choose: ${ROOM_COLUMNS.map((column) => column.key).join(', ')}`);
    }
    const sort = {key, descending: flag(values, 'desc')};
    if (isInteractive(values)) {
        let roomId: string | undefined;
        let sessionId: string | undefined;
        let notice = '';
        while (true) {
            const selection = await new RoomBrowser(store, {sort, roomId, sessionId, notice, discover: networkRoomSearch(store), invitations: listedInvitations(store)}).run();
            if (!selection) {
                return 0;
            }
            roomId = selection.roomId;
            sessionId = 'sessionId' in selection ? selection.sessionId : undefined;
            notice = '';
            // A room found on the network is joined first, and an invitation accepted first; joining then enters the chat.
            const command = 'joinAt' in selection ? ['join', 'local', roomId, '--server', selection.joinAt, '--human'] : 'invitationId' in selection ? ['join', 'online', roomId, '--human'] : ['chat', '--human', '--room', roomId, '--session', sessionId!];
            try {
                if ('invitationId' in selection) {
                    await acceptInvitation(store, selection.invitationId);
                }
                // Chat deliberately exits its process on /quit. Give it the
                // terminal in a child so quitting returns to this navigator.
                notice = await new Promise<string>((resolve, reject) => {
                    const child = spawn(process.execPath, [process.argv[1]!, ...command], {stdio: ['inherit', 'inherit', 'pipe']});
                    let error = '';
                    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4000); });
                    child.once('error', reject);
                    child.once('close', (code) => resolve(code === 0 ? '' : error.trim() || `Chat ended with status ${code ?? 'signal'}.`));
                });
            } catch (error) {
                notice = error instanceof Error ? error.message : 'Could not open this session.';
            }
        }
    }
    const entries = await loadRoomList(store);
    if (flag(values, 'json')) {
        json(roomListJson(store, entries, sort));
    } else {
        const byId = new Map(entries.map((entry) => [entry.room.roomId, entry]));
        renderRoomList(sortListRows(roomRows(entries), sort).map((row) => byId.get(row.id)!));
    }
    return 0;
}

async function findCommand(store: LocalStore, values: Values): Promise<number> {
    let rooms = str(values, 'room') ? [resolveRoom(store, str(values, 'room'))] : store.rooms();
    const server = str(values, 'server');
    if (server && flag(values, 'local')) {
        throw new UsageError('use either --server or --local, not both');
    }
    if (server) {
        rooms = rooms.filter((room) => room.serverUrl.replace(/\/+$/, '') === server.replace(/\/+$/, ''));
    } else if (flag(values, 'local')) {
        rooms = rooms.filter((room) => {
            try {
                return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(room.serverUrl).hostname);
            } catch {
                return false;
            }
        });
    }
    const result = await findRooms(store, {rooms});
    if (flag(values, 'active')) {
        result.rooms = result.rooms.filter((room) => room.active === true);
        result.count = result.rooms.length;
    }
    if (flag(values, 'json')) {
        json(result);
    } else {
        out(formatFoundRooms(result));
    }
    return 0;
}

async function findOnline(store: LocalStore, values: Values): Promise<number> {
    const {server, rooms} = await onlineRooms(store);
    if (flag(values, 'json')) {
        json({server, count: rooms.length, rooms});
        return 0;
    }
    if (rooms.length === 0) {
        out('Your account has no rooms yet. Create one with: pairlobby create online --name <name>');
        return 0;
    }
    for (const room of rooms) {
        const people = room.participants.map((participant) => `${participant.displayName}${participant.kind === 'agent' ? ' (agent)' : ''}`).join(', ') || 'nobody joined';
        const state = room.lifecycle === 'open' ? '' : ` · ${room.lifecycle}`;
        out(`${room.name}  ${room.roomId}${room.owner ? ' · yours' : ''}${room.shared ? ' · shared with you' : ''}${room.private ? ' · private' : ''}${state}`);
        out(`  ${people}`);
    }
    out('');
    out('Join from this device: pairlobby join online <room name or id> [--runtime codex|claude|qwen]');
    return 0;
}

function parseExpirySpec(spec: string): number | null {
    try {
        return parseExpiry(spec);
    } catch (error) {
        throw new UsageError(error instanceof WhenError ? error.message : String(error));
    }
}

/**
 * Opens a room to read-only guests, or closes it again.
 *
 * This makes the room id enough to get in, which turns an identifier that is
 * printed by `list`, by errors, and in logs into a credential. The warning is
 * printed at the moment of opting in because that is the only moment anyone is
 * thinking about it.
 */
/** Lets anyone on the relay's local network or tailnet join by name, as a member; --off stops it. */
async function setLocalJoin(store: LocalStore, values: Values, reference?: string): Promise<number> {
    const room = resolveRoom(store, reference ?? str(values, 'room'));
    const localJoin = !flag(values, 'off');
    await new PairLobbyClient(room.serverUrl).setLocalJoin(room.roomId, controllerCredential(store, room), localJoin);
    if (flag(values, 'json')) {
        json({roomId: room.roomId, localJoin});
        return 0;
    }
    if (!localJoin) {
        out(`${room.name} can no longer be joined by name. Members who joined that way stay until you remove them.`);
        return 0;
    }
    out(`${room.name} is open to the local network.`);
    await printLocalJoin(room.serverUrl, room.name);
    return 0;
}

/** How other devices join an open-local room, and whether this relay can actually be reached by them. */
async function printLocalJoin(serverUrl: string, name: string): Promise<void> {
    out('');
    out(`  pairlobby join ${/\s/.test(name) ? `"${name}"` : name}`);
    out('');
    note('anyone on this relay\'s local network or tailnet can join by that name as a member who can send messages.');
    note('Locking the room still refuses them; close it again with: pairlobby open-local <room> --off');
    if ((await shareTarget(serverUrl)).localOnly) {
        note('this relay only listens on this device, so other devices cannot reach it yet: pairlobby settings network-sharing tailscale (or lan), then restart the relay');
    }
}

async function setAccess(store: LocalStore, values: Values, reference?: string): Promise<number> {
    const room = resolveRoom(store, reference ?? str(values, 'room'));
    const joinPolicy = flag(values, 'off') ? ('invite_only' as const) : ('open_to_guests' as const);
    const credential = controllerCredential(store, room);
    await new PairLobbyClient(room.serverUrl).setJoinPolicy(room.roomId, credential, joinPolicy);

    if (flag(values, 'json')) {
        json({roomId: room.roomId, joinPolicy});
        return 0;
    }
    if (joinPolicy === 'invite_only') {
        out(`${room.name} is invite only again. Existing guests keep their access until you remove them.`);
        return 0;
    }
    out(`${room.name} is open to guests.`);
    out('');
    out(`  pairlobby join ${room.roomId}`);
    out('');
    note('anyone holding that room id can now read the whole transcript. Guests cannot send,');
    note('hand over, or control anything. Close it again with: pairlobby open <room> --off');
    return 0;
}

/** The menu form of `expiry`, for when you would rather not phrase a time. */
async function expireInteractive(store: LocalStore, values: Values, reference?: string): Promise<number> {
    const room = resolveRoom(store, reference ?? str(values, 'room'));
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new UsageError('pairlobby expire needs a terminal; use "pairlobby expiry <room> <when>" instead');
    }
    const credential = controllerCredential(store, room);
    const client = new PairLobbyClient(room.serverUrl);
    const snapshot = await client.snapshot(room.roomId, credential);

    const chosen = await pickExpiry(room.name, snapshot.expiresAt);
    // Backing out and confirming what was already set are both "no change"; only
    // the first is a cancellation, and neither is an error.
    if (chosen === undefined || chosen === snapshot.expiresAt) {
        note('left unchanged');
        return 0;
    }
    await client.setExpiry(room.roomId, credential, chosen);
    store.upsertRoom({...room, expiresAt: chosen});
    out(chosen === null ? `${room.name} will not expire` : `${room.name} expires ${new Date(chosen).toLocaleString()}`);
    return 0;
}

/** Shows or sets when a room expires. */
async function expiryCommand(store: LocalStore, values: Values, args: string[]): Promise<number> {
    // The room is optional, so `expiry in 2 days` works when only one room is
    // active. A first word that parses as part of a time spec is not a room name.
    const looksLikeSpec = (word: string | undefined) => word !== undefined && /^(never|none|off|no|permanent|forever|in|at|on|\d)/i.test(word);
    const reference = looksLikeSpec(args[0]) ? undefined : args[0];
    const spec = (looksLikeSpec(args[0]) ? args : args.slice(1)).join(' ').trim();
    const room = resolveRoom(store, reference ?? str(values, 'room'));

    if (spec.length === 0) {
        const client = new PairLobbyClient(room.serverUrl);
        const credential = store.credential(room.roomId, 'controller') ?? room.sessions.map((session) => store.credential(room.roomId, session.sessionId)).find(Boolean);
        if (!credential) {
            throw new UsageError(`no credential for ${room.name} on this device`);
        }
        const snapshot = await client.snapshot(room.roomId, credential);
        if (flag(values, 'json')) {
            json({roomId: room.roomId, expiresAt: snapshot.expiresAt});
            return 0;
        }
        out(snapshot.expiresAt === null ? `${room.name} never expires` : `${room.name} expires ${new Date(snapshot.expiresAt).toLocaleString()}`);
        return 0;
    }

    const expiresAt = parseExpirySpec(spec);
    const credential = controllerCredential(store, room);
    await new PairLobbyClient(room.serverUrl).setExpiry(room.roomId, credential, expiresAt);
    store.upsertRoom({...room, expiresAt});

    if (flag(values, 'json')) {
        json({roomId: room.roomId, expiresAt});
        return 0;
    }
    out(expiresAt === null ? `${room.name} will not expire` : `${room.name} expires ${new Date(expiresAt).toLocaleString()}`);
    return 0;
}

async function renameSelf(store: LocalStore, values: Values, name: string): Promise<number> {
    if (!name.trim()) {
        throw new UsageError('Usage: pairlobby rename-self <new name> --room <room> --session <session>');
    }
    const displayName = validatedName(name);
    const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const current = await client.snapshot(room.roomId, credential);
    if (!current.renameSelfSupported) {
        throw new UsageError('Update this relay before using rename-self.');
    }
    const snapshot = await client.renameSelf(room.roomId, credential, displayName, 'room');
    store.updateSessionName(room.roomId, session.sessionId, displayName, 'room');
    if (flag(values, 'json')) {
        json({roomId: room.roomId, sessionId: session.sessionId, participantId: session.participantId, displayName, nameSource: 'room'});
    } else {
        out(`Your name in ${snapshot.name} is now ${displayName}.`);
    }
    return 0;
}

async function renameRoom(store: LocalStore, values: Values, reference: string | undefined, name: string): Promise<number> {
    if (!reference) {
        throw new UsageError('pairlobby name needs a room and a new name');
    }
    const room = resolveRoom(store, reference);
    if (name.trim().length === 0) {
        throw new UsageError(`pairlobby name ${reference} <new name>`);
    }
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
    if (!reference) {
        throw new UsageError('pairlobby delete needs a room');
    }
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
            throw new UsageError(
                `could not reach ${room.serverUrl}, so the room was not deleted.\n  Start the server and try again, or drop this device's record of it:\n    pairlobby forget ${room.roomId}`
            );
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
function identityFrom(store: LocalStore, values: Values, fallbackName: string): LocalIdentity {
    const detected = detectRuntime();
    const profile = store.profile();
    const profileApplies = flag(values, 'human') || !((detected.runtime !== undefined || str(values, 'runtime')) && profile.kind === 'human');

    // Who is at the keyboard: an agent shelling out either declares a runtime or
    // has no terminal. A person on a TTY with neither is a person, and defaulting
    // them to "agent" made rooms report zero people in them.
    const looksLikeAgent = detected.runtime !== undefined || str(values, 'runtime') !== undefined || process.stdin.isTTY !== true;
    const kind = flag(values, 'human') ? 'human' : flag(values, 'agent') ? 'agent' : (profileApplies && profile.kind) || (looksLikeAgent ? 'agent' : 'human');
    const displayName = str(values, 'as') ?? (profileApplies ? profile.displayName : undefined) ?? (kind === 'human' ? osUserName() : (str(values, 'runtime') ?? detected.runtime)?.replace('-cli', '') ?? fallbackName);
    const runtime = str(values, 'runtime') ?? (kind === 'human' ? undefined : (profile.runtime ?? detected.runtime));
    const capabilities: AdapterCapabilities | undefined = runtime ? {deliverUnsolicited: false, cancelTurn: false, cancelTool: false, runtime} : undefined;
    return {displayName: validatedName(displayName), nameSource: str(values, 'as') !== undefined ? 'room' : 'profile', kind, sessionId: newId('session'), ...(capabilities ? {capabilities} : {})};
}


async function settingsCommand(store: LocalStore, values: Values, key?: string, value?: string): Promise<number> {
    if (flag(values, 'reset')) {
        store.resetSettings();
        note('settings reset to defaults');
        return 0;
    }
    if (key !== undefined) {
        const definition = SETTING_KEYS[key];
        if (!definition) {
            throw new UsageError(`unknown setting "${key}"; known settings: ${Object.keys(SETTING_KEYS).join(', ')}`);
        }
        if (value === undefined) {
            throw new UsageError(`pairlobby settings ${key} <value>`);
        }
        const parsed = parseSettingValue(key, definition, value);
        store.setSettings({[definition.field]: parsed} as Partial<Settings>);
        note(`${key} is now ${describeSettingValue(definition, parsed)}`);
        if (key === 'network-sharing') {
            note(NETWORK_SHARING_RESTART);
        }
        if (flag(values, 'apply-existing')) {
            if (key !== 'auto-close') {
                throw new UsageError('--apply-existing only applies to auto-close');
            }
            const outcomes = await applyAutoCloseToRooms(store, parseAutoClose(String(parsed)));
            if (flag(values, 'json')) {
                json({setting: key, value: parsed, rooms: outcomes});
                return 0;
            }
            note(`applying to ${outcomes.length} saved room(s): ${summarizeBulk(outcomes)}`);
            for (const outcome of outcomes) {
                out(`${outcome.result.padEnd(11)} ${outcome.name} (${outcome.roomId}) — ${outcome.detail}`);
            }
        }
        return 0;
    }
    if (!flag(values, 'json') && process.stdin.isTTY && process.stdout.isTTY) {
        await runSettingsMenu(store);
        return 0;
    }
    const settings = store.settings();
    if (flag(values, 'json')) {
        json(settings);
        return 0;
    }
    const width = Math.max(...Object.keys(SETTING_KEYS).map((name) => name.length));
    for (const [name, definition] of Object.entries(SETTING_KEYS)) {
        out(`${name.padEnd(width)}  ${describeSettingValue(definition, settings[definition.field])}`);
        out(`${' '.repeat(width)}  ${definition.help}`);
    }
    out('');
    note('pairlobby settings <name> <value>   ·   pairlobby settings --reset   ·   run in a terminal for the interactive menu');
    return 0;
}





/**
 * Drops a room from this device without touching the server. The room may still
 * exist and other participants are unaffected — this is how you get rid of a
 * record for a relay that is gone, which `delete` cannot do because `delete`
 * needs the server to answer.
 */
function forgetRoom(store: LocalStore, values: Values, reference: string | undefined): number {
    if (!reference) {
        throw new UsageError('pairlobby forget needs a room');
    }
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

function validatedName(name: string): string {
    const parsed = ParticipantName.safeParse(name);
    if (!parsed.success) {
        throw new UsageError('Use a name of 1–64 characters without control characters; all is reserved.');
    }
    return parsed.data;
}

function invitationTerms(invitation: ReceivedInvitation): string {
    const agents = invitation.agents === 0 ? 'no agents' : `may bring ${invitation.agents} agent${invitation.agents === 1 ? '' : 's'}`;
    return `${invitation.role === 'guest' ? 'read-only observer' : 'member'}, ${agents}`;
}

/**
 * Invitations this account received: list them, accept one, or decline one.
 * Answering is for a person. An agent may list them and tell its person, but
 * joining a room on someone's say-so is not an agent's decision.
 */
async function invitationsCommand(store: LocalStore, values: Values, action?: string, reference?: string): Promise<number> {
    if (action === undefined) {
        const invitations = await receivedInvitations(store);
        rememberInvitations(store, invitations);
        // The detached half of the reminder: the list is saved, and nothing is printed.
        if (flag(values, 'background')) {
            return 0;
        }
        if (flag(values, 'json')) {
            json({count: invitations.length, invitations});
            return 0;
        }
        if (invitations.length === 0) {
            out('No invitations waiting.');
            return 0;
        }
        for (const invitation of invitations) {
            out(`${invitation.roomName}  ${invitation.roomId}`);
            out(`  invited by ${invitation.invitedBy} · ${invitationTerms(invitation)} · expires ${new Date(invitation.expiresAt).toLocaleDateString()}`);
        }
        out('');
        out('Accept:  pairlobby invitations accept <room name or id>');
        out('Decline: pairlobby invitations decline <room name or id>');
        return 0;
    }
    if (!['accept', 'decline'].includes(action) || !reference) {
        throw new UsageError('pairlobby invitations, pairlobby invitations accept <room>, or pairlobby invitations decline <room>');
    }
    if (detectRuntime().runtime !== undefined && !flag(values, 'human')) {
        throw new UsageError('An invitation is answered by a person, not an agent. Tell your person about it; they run this in their own terminal (or add --human if a person is typing here).');
    }
    const received = await receivedInvitations(store);
    const invitation = matchInvitation(received, reference);
    // Once it is answered, either way, it is no longer waiting.
    const answered = () => rememberInvitations(store, received.filter((candidate) => candidate.id !== invitation.id));
    if (action === 'decline') {
        await declineInvitation(store, invitation.id);
        answered();
        if (flag(values, 'json')) {
            json({roomId: invitation.roomId, declined: true});
            return 0;
        }
        out(`Declined the invitation to ${invitation.roomName}.`);
        return 0;
    }
    const accepted = await acceptInvitation(store, invitation.id);
    answered();
    if (flag(values, 'json')) {
        json({...accepted, accepted: true});
        return 0;
    }
    out(`Accepted. ${accepted.roomName} is now one of your account's rooms${accepted.role === 'guest' ? ', as a read-only observer' : ''}.`);
    out('');
    out(`  pairlobby join online ${accepted.roomId}                      # your terminal`);
    if (accepted.role !== 'guest' && invitation.agents > 0) {
        out(`  pairlobby join online ${accepted.roomId} --runtime claude     # an agent, up to ${invitation.agents} at once`);
    }
    return 0;
}

/** Shows or sets this device's default identity, and with --username the account's handle. */
async function profileCommand(store: LocalStore, values: Values): Promise<number> {
    if (str(values, 'username') !== undefined) {
        const handle = await setHandle(store, str(values, 'username')!);
        if (flag(values, 'json')) {
            json({handle});
            return 0;
        }
        out(`Your handle is @${handle}. Room owners invite you with /invite @${handle}.`);
        return 0;
    }
    if (flag(values, 'clear')) {
        store.clearProfile();
        note('profile cleared');
        return 0;
    }
    const update = {
        ...(str(values, 'as') !== undefined ? {displayName: validatedName(str(values, 'as')!)} : {}),
        ...(flag(values, 'human') ? {kind: 'human' as const} : flag(values, 'agent') ? {kind: 'agent' as const} : {}),
        ...(str(values, 'runtime') !== undefined ? {runtime: str(values, 'runtime')!} : {}),
        ...(str(values, 'server') !== undefined ? {server: str(values, 'server')!} : {})
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
    if (profile.runtime) {
        out(`runtime  ${profile.runtime}`);
    }
    if (profile.server) {
        out(`server   ${profile.server}`);
    }
    if (profile.kind === 'human') {
        note('a detected agent runtime ignores this profile, so agents never join as you');
    }
    return 0;
}

/**
 * Local-only detail about where this session is running. It goes in the device
 * registry and never to the relay: a runtime conversation id is how the owner
 * finds their own agent, not something other participants need.
 */
/** A person's login name beats "agent" as a default label for a person. */
function osUserName(): string {
    try {
        return userInfo().username || 'you';
    } catch {
        return 'you';
    }
}

function localDetail(values: Values): LocalRuntimeDetail {
    const detected = detectRuntime();
    // A conversation id is only inherited when this really is the detected runtime
    // talking. A human, or an agent declaring a different runtime, would otherwise
    // be labelled with whichever session happened to spawn the shell — exactly the
    // confusion the field exists to remove.
    const declared = str(values, 'runtime');
    const detectionApplies = !flag(values, 'human') && (declared === undefined || sameRuntime(declared, detected.runtime));
    const conversationId = str(values, 'conversation') ?? (detectionApplies ? detected.conversationId : undefined);
    const runtime = declared ?? (flag(values, 'human') ? undefined : detected.runtime);
    return {...(runtime ? {runtime} : {}), ...(conversationId ? {conversationId} : {}), ...(detected.terminal ? {terminal: detected.terminal} : {}), pid: detected.pid};
}

async function enableReceiver(store: LocalStore, values: Values, roomId: string, sessionId: string): Promise<ReceiverStatus | null> {
    const {session} = select(store, roomId, sessionId);
    if (flag(values, 'manual-receive') || session.kind !== 'agent' || session.role === 'guest' || !receiverRuntimeName(session.runtime)) {
        return null;
    }
    const receiver = await startReceiver(store, roomId, sessionId, str(values, 'model'), str(values, 'workdir'), str(values, 'effort'));
    if (!flag(values, 'json')) {
        const name = receiver.runtime === 'claude' ? 'Claude' : receiver.runtime === 'qwen' ? 'Qwen' : 'Codex';
        note(`Automatic receiver available. Room requests run in a managed ${name} session; no reader or listening agent is needed.`);
    }
    return receiver;
}

/** Applies this device's defaults for new rooms; a relay that refuses one keeps the room and says so. */
async function applyRoomDefaults(client: PairLobbyClient, roomId: string, controller: string, settings: Settings, online: boolean): Promise<void> {
    const changes: [string, () => Promise<unknown>][] = [];
    if (settings.defaultTurnMode === 'parallel') {
        changes.push(['parallel replies', () => client.setTurnMode(roomId, controller, 'parallel')]);
    }
    if (settings.defaultAutoClose !== 'off') {
        changes.push([`auto-close (${settings.defaultAutoClose})`, () => client.setAutoClose(roomId, controller, parseAutoClose(settings.defaultAutoClose))]);
    }
    if (settings.defaultInviteRole === 'guest') {
        changes.push(['read-only invitations', () => client.setInviteRole(roomId, controller, 'guest')]);
    }
    if (!online && settings.defaultGuestAccess === 'open_to_guests') {
        changes.push(['open guest access', () => client.setJoinPolicy(roomId, controller, 'open_to_guests')]);
    }
    for (const [label, apply] of changes) {
        try {
            await apply();
        } catch (error) {
            note(`Room created, but the default for ${label} was not applied: ${error instanceof Error ? error.message : String(error)}. Change it with /settings in the room.`);
        }
    }
}

async function createRoom(store: LocalStore, values: Values, online = false): Promise<number> {
    const name = str(values, 'name');
    if (!name) {
        throw new UsageError('pairlobby create needs --name');
    }
    if (online && (str(values, 'server') || flag(values, 'local'))) {
        throw new UsageError('online cannot be combined with --server or --local');
    }
    if (flag(values, 'private') && flag(values, 'public')) {
        throw new UsageError('use either --private or --public, not both');
    }
    if (flag(values, 'open-local') && online) {
        throw new UsageError('--open-local applies to rooms on your own relay; online rooms are shared through accounts');
    }
    if ((flag(values, 'private') || flag(values, 'public')) && !online) {
        throw new UsageError('--private and --public apply to online rooms: pairlobby create online --name <name> --private');
    }
    const settings = store.settings();
    // The device default decides when neither flag is given.
    const privateRoom = online && (flag(values, 'private') || (settings.defaultPrivateOnline && !flag(values, 'public')));
    if (str(values, 'allow') && !privateRoom) {
        throw new UsageError('--allow requires a private room (--private)');
    }
    const serverUrl = online ? (await onlineAccount(store)).server : resolveServer({server: str(values, 'server') ?? store.profile().server, local: flag(values, 'local')});
    const identity = identityFrom(store, values, 'agent');
    const client = new PairLobbyClient(serverUrl, online ? accountToken(store) : process.env['PAIRLOBBY_ACCOUNT_TOKEN']);
    const lifetime = settings.defaultRoomLifetimeMs;
    const expiresAt = str(values, 'expiry') !== undefined ? parseExpirySpec(str(values, 'expiry')!) : lifetime === null ? null : Date.now() + lifetime;
    const created = await client.createRoom(
        name,
        identity,
        expiresAt,
        online
            ? {
                  private: privateRoom,
                  allowedAccounts: (str(values, 'allow') ?? '')
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
              }
            : undefined
    );

    store.upsertRoom({roomId: created.roomId, name, serverUrl, createdAt: created.room.createdAt, expiresAt: created.room.expiresAt, controls: true, sessions: []});
    // The controller credential stays on disk and out of the result an agent sees.
    store.putCredential(created.roomId, 'controller', created.controllerCredential);
    store.putCredential(created.roomId, identity.sessionId, created.participantCredential);
    store.addSession(created.roomId, {
        participantId: created.participantId,
        sessionId: identity.sessionId,
        displayName: identity.displayName,
        kind: identity.kind,
        role: 'member',
        joinedAt: created.room.createdAt,
        lastReadSeq: 0,
        cwd: process.cwd(),
        ...localDetail(values)
    });

    await applyRoomDefaults(client, created.roomId, created.controllerCredential, settings, online);
    let openLocal = false;
    if (flag(values, 'open-local')) {
        try {
            await client.setLocalJoin(created.roomId, created.controllerCredential, true);
            openLocal = true;
        } catch (error) {
            note(`Room created, but it could not be opened to the local network: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const receiver = await enableReceiver(store, values, created.roomId, identity.sessionId);
    const share = await joinCommand(serverUrl, created.invite.code);
    if (flag(values, 'json')) {
        json({roomId: created.roomId, name, serverUrl, shareServerUrl: share.target.localOnly ? null : share.target.serverUrl, joinCommand: share.command, participantId: created.participantId, sessionId: identity.sessionId, invite: created.invite, ...(flag(values, 'open-local') ? {localJoin: openLocal} : {}), ...localDetail(values), receiver});
        return 0;
    }
    const detail = localDetail(values);
    out(`Room: ${name}`);
    out(`Invite: ${created.invite.code}  (single use)`);
    out(`Session: ${identity.sessionId}`);
    if (detail.conversationId) {
        out(`Conversation: ${detail.conversationId}`);
    }
    out('');
    out(`  ${share.command}`);
    if (share.target.localOnly) {
        note(localOnlyNote(share.target));
    }
    if (share.target.discoverable) {
        note(discoverableNote(created.invite.code));
    }
    if (openLocal) {
        await printLocalJoin(serverUrl, name);
    }
    note('The controller credential for this room was stored on this device and is not printed.');
    return 0;
}

/** True when nothing on the command line, in the environment or in the profile says which relay to use. */
function namesNoRelay(store: LocalStore, values: Values): boolean {
    return !str(values, 'server') && !flag(values, 'local') && !process.env['PAIRLOBBY_SERVER'] && !store.profile().server;
}

async function discoverRelay(code: string): Promise<string> {
    const found = await findRelayForInvite(code);
    if (found !== DEFAULT_LOCAL_SERVER) {
        note(`found the relay for ${code} at ${found}`);
    }
    return found;
}

async function joinRoom(store: LocalStore, values: Values, code?: string, online = false, local = false): Promise<number> {
    if (!code) {
        throw new UsageError(local ? 'pairlobby join local needs a room name or id' : 'pairlobby join needs an invite code, a room name or the id of an open room');
    }
    if (online && (str(values, 'server') || flag(values, 'local'))) {
        throw new UsageError('online cannot be combined with --server or --local');
    }
    const link = online ? null : parseJoinLink(code);
    if (link && (str(values, 'server') || flag(values, 'local'))) {
        throw new UsageError('a join link already names its server; drop --server or --local');
    }
    if (link) {
        code = link.code;
    }
    // Neither a code, a room id nor a link: a room name, joined over the local network.
    if (!online && !link && !code.startsWith('rm_') && normalizeInviteCode(code) === null) {
        local = true;
    }
    if (local) {
        return joinLocalRoom(store, values, code);
    }
    // Online, a dash-grouped key is an invite; anything else names one of the account's own rooms.
    // A room someone invited this account into lives on their relay, so each room names its own.
    const accountRoom = online && !isOnlineKey(code) ? await onlineRooms(store).then(({rooms}) => matchOnlineRoom(rooms, code)).then((room) => ({server: room.server, room})) : null;
    const serverUrl = accountRoom ? accountRoom.server : online ? await resolveOnlineKey(store, code) : (link?.serverUrl ?? (namesNoRelay(store, values) && !code.startsWith('rm_') ? await discoverRelay(code) : resolveServer({server: str(values, 'server') ?? store.profile().server, local: flag(values, 'local')})));
    const identity = identityFrom(store, values, 'agent');
    const token = new URL(serverUrl).origin === onlineOrigin() ? accountToken(store) : undefined;
    const client = new PairLobbyClient(serverUrl, token);
    const useInviteName = str(values, 'as') === undefined && !(identity.kind === 'human' && store.profile().displayName);
    // A room id and an invite code are not confusable, so one command takes either.
    const joined = accountRoom
        ? await client.joinWithAccount(accountRoom.room.roomId, identity)
        : code.startsWith('rm_')
          ? await client.joinAsGuest(code, identity)
          : await client.redeemInvite(code, identity, undefined, useInviteName);
    return finishJoin(store, values, joined, serverUrl, identity, accountRoom || code.startsWith('rm_') ? undefined : code);
}

/**
 * Joins a room open to the local network by name, or by id with --server: asks the
 * relays this device can see, joins the single match as a member.
 */
async function joinLocalRoom(store: LocalStore, values: Values, reference: string): Promise<number> {
    const named = namesNoRelay(store, values) ? undefined : resolveServer({server: str(values, 'server') ?? store.profile().server, local: flag(values, 'local')});
    if (reference.startsWith('rm_') && !named) {
        throw new UsageError('joining by room id needs its relay: pairlobby join local <room-id> --server <address>');
    }
    const match = reference.startsWith('rm_') ? {url: named!, roomId: reference} : await findLocalRoom(reference, undefined, named).then((found) => ({url: found.url, roomId: found.room.roomId}));
    if (!named && match.url !== DEFAULT_LOCAL_SERVER) {
        note(`found ${reference} at ${match.url}`);
    }
    const identity = identityFrom(store, values, 'agent');
    const joined = await new PairLobbyClient(match.url).joinOnLocalNetwork(match.roomId, identity);
    return finishJoin(store, values, joined, match.url, identity);
}

/** Saves a new membership on this device, starts its receiver when it has one, then enters or describes the room. */
async function finishJoin(store: LocalStore, values: Values, joined: JoinedRoom, serverUrl: string, identity: LocalIdentity, code?: string): Promise<number> {
    identity.displayName = joined.room.participants.find((participant) => participant.participantId === joined.participantId)?.displayName ?? identity.displayName;

    store.upsertRoom({
        roomId: joined.roomId,
        name: joined.room.name,
        serverUrl,
        createdAt: joined.room.createdAt,
        expiresAt: joined.room.expiresAt,
        controls: store.room(joined.roomId)?.controls ?? false,
        sessions: store.room(joined.roomId)?.sessions ?? []
    });
    store.putCredential(joined.roomId, identity.sessionId, joined.participantCredential);
    if (code) {
        store.putSessionInvite(joined.roomId, identity.sessionId, code);
    }
    store.addSession(joined.roomId, {
        participantId: joined.participantId,
        sessionId: identity.sessionId,
        displayName: identity.displayName,
        kind: identity.kind,
        role: joined.role,
        joinedAt: Date.now(),
        lastReadSeq: 0,
        cwd: process.cwd(),
        ...localDetail(values)
    });

    const receiver = await enableReceiver(store, values, joined.roomId, identity.sessionId);
    if (flag(values, 'json')) {
        json({
            roomId: joined.roomId,
            name: joined.room.name,
            serverUrl,
            participantId: joined.participantId,
            sessionId: identity.sessionId,
            role: joined.role,
            receiver,
            ...localDetail(values),
            participants: joined.room.participants.map((participant) => ({participantId: participant.participantId, displayName: participant.displayName}))
        });
        return 0;
    }
    const detail = localDetail(values);
    // Joining a room means being in it. Only a machine caller — --json, a pipe,
    // or an explicit --no-follow — gets a printed snapshot and its prompt back.
    if (isInteractive(values) && !receiver) {
        note(`joined ${joined.room.name} as ${identity.displayName}${joined.role === 'guest' ? ' — read-only guest' : ''}`);
        return chatRoom(store, {...values, room: joined.roomId, session: identity.sessionId});
    }
    out(`Joined ${joined.room.name} as ${identity.displayName}${joined.role === 'guest' ? ' (read-only guest)' : ''}`);
    out(`Session: ${identity.sessionId}`);
    if (detail.conversationId) {
        out(`Conversation: ${detail.conversationId}`);
    }
    out('');
    renderSnapshot(joined.room);
    return 0;
}

async function sendMessage(store: LocalStore, values: Values, text: string): Promise<number> {
    if (text.trim().length === 0) {
        throw new UsageError('pairlobby send needs a message');
    }
    const wait = Number(str(values, 'wait-for-ack') ?? 30);
    if (!Number.isFinite(wait) || wait < 0 || wait > 300) {
        throw new UsageError('--wait-for-ack must be between 0 and 300 seconds');
    }
    const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const recipient = str(values, 'to');
    const replyTo = str(values, 'reply-to');
    if (replyTo) {
        return replyMessage(store, values, replyTo, text);
    }
    const snapshot = recipient ? await client.snapshot(room.roomId, credential) : undefined;
    const references = recipient?.split(',').map((name) => name.trim().replace(/^@/, '')).filter(Boolean) ?? [];
    if (recipient && !references.length) {
        throw new UsageError('--to needs one or more names, or all');
    }
    const everyone = references.length === 1 && references[0]!.toLowerCase() === 'all';
    const selected = everyone ? [] : [...new Set(references.map((reference) => resolveRecipient(snapshot!.participants, reference)))];
    const requested: RoutedChatMessage = everyone ? {text, recipientId: null, allRecipients: true} : selected.length > 1 ? {text, recipientId: null, recipientIds: selected} : {text, recipientId: selected[0] ?? null};
    const routed = snapshot ? routeForRoom(requested, snapshot.participants, session.participantId) : requested;
    const {recipientId, recipientIds, allRecipients} = routed;
    const group = Boolean(allRecipients || recipientIds);
    if (group && !snapshot?.groupTurnsSupported) {
        throw new UsageError('Update this relay before sending to multiple agents.');
    }
    if ((requested.allRecipients || requested.recipientIds) && !group) {
        note(recipientId ? 'only one agent was named, so the message goes to it; the people named read it in the room' : 'no agent to ask, so the message is posted to the room for everyone to read');
    }
    // The key is generated once so a retry after a lost response is a replay, not a second message.
    const result = await client.send(room.roomId, credential, {
        type: 'message',
        payload: {text, priority: 'normal'},
        idempotencyKey: newId('event'),
        ...(recipientId ? {recipientId} : {}),
        ...(allRecipients ? {allRecipients: true} : recipientIds ? {recipientIds} : {})
    });

    const seconds = flag(values, 'no-wait') ? 0 : Number(str(values, 'wait-for-ack') ?? 30);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) {
        throw new UsageError('--wait-for-ack must be between 0 and 300 seconds');
    }
    let acknowledged = false;
    let queuedForTurn = false;
    const waitForGroup = group && str(values, 'wait-for-ack') !== undefined && !flag(values, 'no-wait');
    if (waitForGroup && seconds > 0) {
        const expected = new Set(result.event.recipientIds ?? []);
        const received = new Set<string>();
        const deadline = Date.now() + seconds * 1000;
        let cursor = result.event.seq;
        while (Date.now() < deadline) {
            const page = await client.readEvents(room.roomId, credential, cursor);
            for (const event of page.events) {
                if (event.type === 'message.received' && event.payload.eventId === result.event.eventId && event.senderId && expected.has(event.senderId)) {
                    received.add(event.senderId);
                }
            }
            cursor = page.events.at(-1)?.seq ?? cursor;
            if (received.size === expected.size) {
                acknowledged = true;
                break;
            }
            if (!page.hasMore) {
                await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
            }
        }
    }
    if (recipientId && seconds > 0) {
        const deadline = Date.now() + seconds * 1000;
        note(`queued ${result.event.eventId}; waiting for the recipient's acknowledgement`);
        while (Date.now() < deadline) {
            const request = await client.request(room.roomId, credential, result.event.eventId);
            if (request.receivedAt !== null) {
                acknowledged = true;
                break;
            }
            if (request.failureAt) {
                break;
            }
            if (snapshot?.groupTurnsSupported) {
                const queue = await client.turnQueue(room.roomId, credential);
                const position = queue.entries.findIndex((entry) => entry.requestId === result.event.eventId);
                if (position > 0 || queue.entries[position]?.state === 'stalled') {
                    queuedForTurn = true;
                    break;
                }
            }
            await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
        }
    }
    const timedOut = (!!recipientId || waitForGroup) && seconds > 0 && !acknowledged && !queuedForTurn;
    if (flag(values, 'json')) {
        json({
            seq: result.event.seq,
            eventId: result.event.eventId,
            deduplicated: result.deduplicated,
            delivery: acknowledged ? 'acknowledged' : timedOut ? 'unconfirmed' : 'queued',
            requiresReply: !!recipientId || group,
            ...(group ? {recipientIds: result.event.recipientIds} : {}),
            ...(queuedForTurn ? {waitingForTurn: true} : {}),
            error: timedOut ? 'Recipient did not acknowledge before the deadline. The request is still queued; do not resend it as a new request.' : null
        });
    } else {
        note(
            acknowledged
                ? `acknowledged ${result.event.eventId}; a final reply is still required`
                : timedOut ? `DELIVERY UNCONFIRMED: ${result.event.eventId}. The request remains pending; check the recipient adapter.` : `queued ${result.event.eventId}`
        );
    }
    return timedOut ? 1 : 0;
}

async function messageStatusCommand(store: LocalStore, values: Values, eventId?: string, status?: string, responseEventId?: string): Promise<number> {
    const action = status?.replaceAll('-', '_');
    if (!eventId || !/^ev_[0-9A-Z]{26}$/.test(eventId) || !action || (action !== 'read' && !MessageAction.safeParse(action).success) || (action === 'done' && (!responseEventId || !/^ev_[0-9A-Z]{26}$/.test(responseEventId)))) {
        throw new UsageError('Use message-status <delivery-id> read|working|waiting|no-action|declined, or link-answer <request-id> <answer-id>.');
    }
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const reason = str(values, 'reason');
    const turnToken = str(values, 'turn-token');
    try {
        await client.reportMessageStatus(room.roomId, credential, eventId, action as MessageAction | 'read', {...(reason ? {reason} : {}), ...(turnToken ? {turnToken} : {}), ...(responseEventId ? {responseEventId} : {})});
        if (flag(values, 'json')) {
            json({eventId, state: action, ...(responseEventId ? {responseEventId} : {}), furtherActionExpected: action === 'read' ? null : !['done', 'no_action', 'declined'].includes(action)});
        } else {
            out(`${action.replaceAll('_', ' ')} recorded for ${eventId}${responseEventId ? `; answer ${responseEventId} linked` : ''}`);
        }
        return 0;
    } finally {
        client.closeLive();
    }
}

async function receiptMessage(store: LocalStore, values: Values, eventId?: string): Promise<number> {
    if (!eventId) {
        throw new UsageError('receipt requires an event id');
    }
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    await client.acknowledgeMessage(room.roomId, credential, eventId);
    if (flag(values, 'json')) {
        json({acknowledged: eventId});
    } else {
        note(`acknowledged ${eventId}`);
    }
    return 0;
}
async function replyMessage(store: LocalStore, values: Values, eventId: string | undefined, text: string): Promise<number> {
    if (!eventId || !text.trim()) {
        throw new UsageError('reply needs an event id and a non-empty answer (a refusal or unknown answer is valid)');
    }
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const result = await client.reply(room.roomId, credential, eventId, text, flag(values, 'progress'), str(values, 'turn-token'));
    if (flag(values, 'json')) {
        json({eventId: result.event.eventId, replyTo: eventId, final: !flag(values, 'progress')});
    } else {
        note(`${flag(values, 'progress') ? 'progress' : 'answer'} recorded for ${eventId}`);
    }
    return 0;
}
async function requestStatus(store: LocalStore, values: Values): Promise<number> {
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const page = await client.requests(room.roomId, credential, Number(str(values, 'after') ?? 0));
    const requests = page.requests.map((request) => ({...request, state: requestState(request)}));
    if (flag(values, 'json')) {
        json({requests, hasMore: page.hasMore});
    } else {
        for (const request of requests) out(`${request.eventId}  ${request.state}  ${request.text.slice(0, 100)}`);
        if (!requests.length) {
            out('No unanswered requests.');
        }
        if (page.hasMore) {
            note('More requests remain; continue with --after using the last seq.');
        }
    }
    return 0;
}
async function guardStop(store: LocalStore, values: Values): Promise<number> {
    let repeated = false;
    if (!process.stdin.isTTY) {
        try {
            const input = JSON.parse(readFileSync(0, 'utf8')) as {stop_hook_active?: boolean};
            repeated = input.stop_hook_active === true;
        } catch {
            /* Manual invocation can supply an empty input. */
        }
    }
    try {
        const {room, credential, client, session} = select(store, str(values, 'room'), str(values, 'session'));
        const suspended = suspendedReplyParents(join(store.directory, 'receivers', session.sessionId));
        const pending = (await client.pendingRequests(room.roomId, credential, session.participantId)).filter((request) => !request.turnRequired && !suspended.has(request.eventId));
        if (pending.length && repeated) {
            for (const request of pending)
                await client.deliveryFailed(
                    room.roomId,
                    credential,
                    request.eventId,
                    'The runtime attempted to finish again without replying after a Stop-hook reminder. Human intervention is required. No final reply was fabricated.'
                );
            json({
                systemMessage: `PAIRLOBBY FAILURE: ${pending.length} requests remain unanswered. Adapter failure was recorded in the room. The runtime is allowed to stop to avoid an infinite model loop; these requests are NOT resolved.`
            });
        } else if (pending.length) {
            json({
                decision: 'block',
                reason: `PairLobby has ${pending.length} unanswered requests. Run pairlobby read --room ${room.roomId} --session ${session.sessionId} --json, then use pairlobby reply <event-id> <answer> with the same --room and --session for each request. A refusal or unknown answer is valid; progress is not a final answer. Pending IDs: ${pending.map((r) => r.eventId).join(', ')}`
            });
        } else {
            json({});
        }
    } catch {
        json(
            repeated
                ? {
                      systemMessage:
                          'PAIRLOBBY FAILURE: the relay is unreachable and completion could not be verified or recorded. Requests remain unconfirmed; human intervention is required.'
                  }
                : {
                      decision: 'block',
                      reason: 'PairLobby could not verify your inbox. Restore relay access or report the failure explicitly. Do not claim that room requests were answered.'
                  }
        );
    }
    return 0;
}

async function readEvents(store: LocalStore, values: Values): Promise<number> {
    const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const after = str(values, 'after') !== undefined ? Number(str(values, 'after')) : session.lastReadSeq;
    const waitSeconds = str(values, 'wait') !== undefined ? Number(str(values, 'wait')) : 0;
    const before = await client.requests(room.roomId, credential, 0, 100, session.participantId);
    const hasPending = before.requests.some((request) => request.to === session.participantId);
    const page =
        waitSeconds > 0 && !hasPending ? await waitForEvents(client, room.roomId, credential, session.participantId, after, waitSeconds, flag(values, 'all'), store.settings().pollIntervalMs) : await client.readEvents(room.roomId, credential, after);
    const snapshot = await client.snapshot(room.roomId, credential);
    const names = new Map(snapshot.participants.map((participant) => [participant.participantId, participant.displayName] as const));

    const inbox = await client.requests(room.roomId, credential, 0, 100, session.participantId);
    const owed = inbox.requests.filter((request) => request.to === session.participantId);
    // Persist receipts before advancing the cursor. A failed receipt is retried
    // by the next read; it must never be swallowed as a courtesy failure.
    const member = snapshot.participants.find((participant) => participant.participantId === session.participantId);
    const ids = new Set(member && member.role !== 'guest' ? [
        ...unreceipted(page.events, session.participantId, snapshot.messageReceiptScope === 'members').map((event) => event.eventId),
        ...owed.filter((request) => request.receivedAt === null).map((request) => request.eventId)
    ] : []);
    for (const id of ids) await client.acknowledgeMessage(room.roomId, credential, id);
    for (const request of owed)
        if (ids.has(request.eventId)) {
            request.receivedAt ??= Date.now();
        }
    if (page.events.length > 0) {
        store.updateCursor(room.roomId, session.sessionId, page.events.at(-1)!.seq);
    }

    if (flag(values, 'json')) {
        json({
            events: page.events,
            hasMoreRequests: inbox.hasMore,
            latestSeq: page.latestSeq,
            hasMore: page.hasMore,
            addressedToMe: page.events.filter((event) => event.recipientId === session.participantId || event.recipientIds?.includes(session.participantId)).map((event) => event.eventId),
            awaitingYourReply: owed.map((request) => ({
                eventId: request.eventId,
                from: names.get(request.from) ?? request.from,
                text: request.text,
                waitingSeconds: Math.round((Date.now() - request.at) / 1000),
                state: requestState(request)
            }))
        });
        return 0;
    }
    if (page.events.length === 0 && owed.length === 0) {
        note(`nothing new in ${room.name} since #${after}`);
        return 0;
    }
    renderEvents(page.events, names);
    if (page.hasMore) {
        note('more events remain; run read again');
    }
    if (owed.length > 0) {
        note('');
        note(`${owed.length} ${owed.length === 1 ? 'request is' : 'requests are'} waiting on you. Answer, or say you will not:`);
        for (const request of owed) note(`  ${names.get(request.from) ?? request.from}, ${Math.round((Date.now() - request.at) / 1000)}s ago: ${request.text.slice(0, 72)}`);
    }
    return 0;
}

function isInteractive(values: Values): boolean {
    return !flag(values, 'json') && !flag(values, 'no-follow') && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Enters a room already joined on this device. */
async function chatRoom(store: LocalStore, values: Values): Promise<number> {
    const interactive = isInteractive(values);
    const explicitSession = str(values, 'session') ?? process.env['PAIRLOBBY_SESSION'];
    const humanChat = flag(values, 'human') || (interactive && !flag(values, 'agent') && !str(values, 'runtime') && !detectRuntime().runtime);
    const {room, session, credential, client} = humanChat && !explicitSession
        ? await selectHumanSession(store, resolveRoom(store, str(values, 'room')), interactive ? chooseHumanSession : undefined)
        : select(store, str(values, 'room'), explicitSession);
    if (!interactive) {
        return watchRoom(store, {...values, room: room.roomId, session: session.sessionId});
    }
    return runChatRoom({
        requireHuman: humanChat && !explicitSession,
        useHumanProfile: session.kind === 'human',
        store,
        client,
        roomId: room.roomId,
        credential,
        sessionId: session.sessionId,
        participantId: session.participantId,
        controllerCredential: store.credential(room.roomId, 'controller'),
        readOnly: session.role === 'guest',
        intervalMs: str(values, 'interval') !== undefined ? Number(str(values, 'interval')) : store.settings().pollIntervalMs,
        showIds: store.settings().showIds,
        fromStart: true
    });
}

/** A bounded exact-reply check; the timeout does not fail the room request. */
async function waitReplyCommand(store: LocalStore, values: Values, requestId?: string): Promise<number> {
    if (!requestId || !/^ev_[A-Z0-9]+$/.test(requestId)) {
        throw new UsageError('wait-reply requires an outgoing recipient delivery ID');
    }
    const seconds = Number(str(values, 'wait') ?? 30);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1800) {
        throw new UsageError('--wait must be between 0 and 1800 seconds');
    }
    const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    client.closeLive();
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        const outcome = await waitForReply({serverUrl: room.serverUrl, roomId: room.roomId, participantId: session.participantId, credential, requestId, seconds, signal: abort.signal});
        if (flag(values, 'json')) {
            json({...outcome, retryable: outcome.state === 'pending'});
        } else if (outcome.state === 'pending') {
            out('Still waiting. The wait window ended normally; the request remains pending.');
        } else {
            out(`${outcome.state}: ${outcome.text ?? outcome.reason ?? outcome.requestId}`);
        }
        return outcome.state === 'unavailable' || outcome.state === 'failed' ? 1 : 0;
    } catch (error) {
        if (!abort.signal.aborted) {
            throw error;
        }
        if (flag(values, 'json')) {
            json({requestId, state: 'stopped', reason: 'Local wait cancelled; the room request is unchanged.'});
        }
        return 0;
    } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
}

/** Follow the full transcript. Hosted relays use socket notifications; local relays poll. */
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
    const stop = () => {
        stopped = true;
        client.closeLive();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    while (!stopped) {
        let page;
        try {
            page = await client.readEvents(room.roomId, credential, cursor);
        } catch (error) {
            // A relay that went away should not end the watch; a room that ended should.
            if (error instanceof ProtocolError && (error.code === 'room_expired' || error.code === 'room_closed' || error.code === 'participant_revoked')) {
                throw error;
            }
            if (error instanceof ProtocolError && error.code === 'server_unavailable') {
                note('relay unreachable, retrying');
                await sleep(intervalMs * 2);
                continue;
            }
            throw error;
        }
        if (page.events.length > 0) {
            const member = snapshot.participants.find((person) => person.participantId === session.participantId);
            if (member?.kind === 'agent' && member.role !== 'guest' && !member.left && !member.revoked && snapshot.lifecycle === 'open') {
                try {
                    for (const event of unreceipted(page.events, session.participantId, snapshot.messageReceiptScope === 'members')) {
                        await client.acknowledgeMessage(room.roomId, credential, event.eventId);
                    }
                } catch (error) {
                    if (error instanceof ProtocolError && error.code === 'server_unavailable') {
                        await sleep(Math.max(intervalMs, 1000));
                        continue;
                    }
                    throw error;
                }
            }
            cursor = page.events.at(-1)!.seq;
            store.updateCursor(room.roomId, session.sessionId, cursor);
            for (const event of page.events) {
                if (event.senderId && !names.has(event.senderId)) {
                    const refreshed = await client.snapshot(room.roomId, credential);
                    for (const participant of refreshed.participants) names.set(participant.participantId, participant.displayName);
                }
            }
            if (machine) {
                for (const event of page.events) process.stdout.write(`${JSON.stringify(event)}\n`);
            } else {
                renderEvents(page.events, names);
            }
        }
        if (page.hasMore) {
            continue;
        }
        await client.waitForChange(room.roomId, credential, cursor, 300_000, intervalMs).catch(async () => {
            if (!stopped) {
                await sleep(Math.max(intervalMs, 1000));
            }
        });
    }
    client.closeLive();
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
        if (!store.setConversation(room.roomId, target.sessionId, conversation)) {
            throw new UsageError('could not update that session');
        }
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
        if (entry.terminal) {
            out(`  terminal      ${entry.terminal}`);
        }
        if (entry.pid) {
            out(`  invoked by pid ${entry.pid}`);
        }
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
async function waitForEvents(client: PairLobbyClient, roomId: string, credential: string, participantId: string, after: number, seconds: number, wakeOnAnything: boolean, intervalMs: number
) {
    const deadline = Date.now() + seconds * 1000;
    let cursor = after;
    let latest = after;
    const collected: Awaited<ReturnType<PairLobbyClient['readEvents']>>['events'] = [];

    try {
        for (;;) {
            const page = await client.readEvents(roomId, credential, cursor);
            if (page.events.length > 0) {
                cursor = page.events.at(-1)!.seq;
                collected.push(...page.events);
                const wakes = wakeOnAnything
                    ? page.events.some((event) => event.senderId !== participantId)
                    : page.events.some((event) => event.recipientId === participantId && event.senderId !== participantId);
                if (wakes) {
                    return {events: collected, earliestSeq: 0, latestSeq: page.latestSeq, hasMore: page.hasMore};
                }
            }
            latest = page.latestSeq;
            if (Date.now() >= deadline) {
                return {events: collected, earliestSeq: 0, latestSeq: latest, hasMore: false};
            }
            if (!page.hasMore) {
                await client.waitForChange(roomId, credential, cursor, Math.max(0, deadline - Date.now()), intervalMs);
            }
        }
    } finally {
        client.closeLive();
    }
}

async function status(store: LocalStore, values: Values): Promise<number> {
    const {room, session, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const receiver = receiverStatus(store, session.sessionId);
    const snapshot = await client.snapshot(room.roomId, credential);
    const pending = await client.requests(room.roomId, credential);
    const names = new Map(snapshot.participants.map((participant) => [participant.participantId, participant.displayName] as const));
    const open = pending.requests.map((request) => ({...request, received: request.receivedAt !== null, waitingMs: Date.now() - request.at, state: requestState(request)}));

    if (flag(values, 'json')) {
        json({...snapshot, receiver, openRequests: open.map((request) => ({...request, from: names.get(request.from) ?? request.from, to: names.get(request.to) ?? request.to}))});
        return 0;
    }
    renderSnapshot(snapshot);
    if (receiver) {
        out(`Automatic receiver: ${receiver.state}${receiver.threadId ? ` (${receiver.runtime} ${receiver.threadId})` : ''}`);
    }
    renderOpenRequests(open, names);
    return 0;
}

async function invite(store: LocalStore, values: Values): Promise<number> {
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    // --expires-in wins, then the device default, then the room's own policy.
    const lifetime = str(values, 'expires-in') !== undefined ? parseLifetime(str(values, 'expires-in')!) : store.settings().defaultInviteLifetimeMs;
    const expiresAt = lifetime === null ? null : Date.now() + lifetime;
    const minted = await client.mintInvite(room.roomId, credential, 'member', !flag(values, 'once'), expiresAt);
    const share = await joinCommand(room.serverUrl, minted.code);

    if (flag(values, 'json')) {
        json({...minted, shareServerUrl: share.target.localOnly ? null : share.target.serverUrl, joinCommand: share.command});
        return 0;
    }
    out(minted.code);
    const deadline = minted.expiresAt === null ? 'does not expire' : `must be used before ${new Date(minted.expiresAt).toLocaleString()}`;
    note(minted.reusable ? `one seat, reusable whenever nobody holds it — ${deadline}` : `single use — ${deadline}`);
    note(`join with: ${share.command}`);
    if (share.target.localOnly) {
        note(localOnlyNote(share.target));
    }
    if (share.target.discoverable) {
        note(discoverableNote(minted.code));
    }
    return 0;
}

async function offerHandover(store: LocalStore, values: Values): Promise<number> {
    if (flag(values, 'template')) {
        out(HANDOVER_TEMPLATE);
        return 0;
    }
    const file = str(values, 'file');
    const recipient = str(values, 'to');
    if (!file) {
        throw new UsageError('pairlobby handover needs --file (or --template to print a starting point)');
    }
    if (!recipient) {
        throw new UsageError('pairlobby handover needs --to');
    }
    const document = parseHandoverFile(readFileSync(file, 'utf8'));
    const {room, credential, client} = select(store, str(values, 'room'), str(values, 'session'));
    const recipientId = resolveRecipient((await client.snapshot(room.roomId, credential)).participants, recipient);

    // An amendment reuses the id and takes the next revision; a new offer starts at 1.
    const revision = str(values, 'revision') !== undefined ? Number(str(values, 'revision')) : 1;
    const existingId = str(values, 'handover-id');
    if (revision > 1 && !existingId) {
        throw new UsageError('amending a handover needs --handover-id naming the handover being revised');
    }
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
    if (!handoverId) {
        throw new UsageError(`pairlobby ${accept ? 'accept' : 'decline'} needs a handover id`);
    }
    const revisionText = str(values, 'revision');
    if (!revisionText) {
        throw new UsageError('pass --revision with the exact revision you read, so a newer one is never accepted by accident');
    }
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
    if (accept) {
        note('acceptance confirms receipt and responsibility; it is not a filesystem lock');
    }
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
    if (!me) {
        throw new UsageError('this session is not a participant of the room any more');
    }
    const revision = str(values, 'revision') !== undefined ? Number(str(values, 'revision')) : me.controlRevision;
    if (revision < 1) {
        throw new UsageError('there is no control request outstanding for this session');
    }

    const result = await client.send(room.roomId, credential, {
        type: 'control.ack',
        payload: {targetParticipantId: session.participantId, revision, outcome: outcome as never},
        idempotencyKey: newId('event')
    });
    if (flag(values, 'json')) {
        json({revision, outcome, seq: result.event.seq});
        return 0;
    }
    out(`Acknowledged control revision ${revision}: ${outcome}`);
    return 0;
}

async function setPaused(store: LocalStore, values: Values, target: string | undefined, paused: boolean): Promise<number> {
    if (!target) {
        throw new UsageError(`pairlobby ${paused ? 'pause' : 'resume'} needs a participant`);
    }
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

async function interruptAgent(store: LocalStore, values: Values, target: string): Promise<number> {
    if (!target) {
        throw new UsageError('pairlobby interrupt needs an agent name or participant id');
    }
    const room = resolveRoom(store, str(values, 'room'));
    const credential = controllerCredential(store, room);
    const client = new PairLobbyClient(room.serverUrl);
    const snapshot = await client.snapshot(room.roomId, credential);
    if (!snapshot.interruptSupported) {
        throw new UsageError('this relay cannot interrupt agents yet; update it, or use "pairlobby pause" to hold later work');
    }
    const targetId = resolveRecipient(snapshot.participants, target);
    const result = await client.interrupt(room.roomId, credential, targetId);
    if (flag(values, 'json')) {
        json({revision: result.revision, targetParticipantId: targetId, fenced: result.fenced});
        return 0;
    }
    out(`Interrupt requested for ${target}, revision ${result.revision}: ${result.fenced.length ? 'its current task can no longer post an answer' : 'it was between tasks'}.`);
    note(`its queue is held until "pairlobby resume ${target}". What actually stopped is what its receiver reports; "pairlobby status" shows it.`);
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

/** Null when the terminal closed or Ctrl+C was pressed before an answer. */
async function askYesNo(question: string): Promise<boolean | null> {
    const {createInterface} = await import('node:readline/promises');
    const terminal = createInterface({input: process.stdin, output: process.stdout});
    try {
        return ['y', 'yes'].includes((await terminal.question(question)).trim().toLowerCase());
    } catch {
        process.stdout.write('\n');
        return null;
    } finally {
        terminal.close();
    }
}

async function installUpdate(store: LocalStore, latest: LatestRelease): Promise<boolean> {
    const install = managedInstall();
    if (!install) {
        note(`This PairLobby runs from ${process.argv[1]}, not from the PairLobby installer, so it cannot replace itself. Update it the way you installed it, or reinstall: curl -fsSL https://pairlobby.com/install.sh | sh`);
        return false;
    }
    await installRelease(latest, install, {say: note});
    writeUpdateState(store, {dismissed: latest.version, installed: null});
    out(`Installed PairLobby ${latest.version}. New terminals use it; running agent receivers keep their version until restarted with pairlobby receiver stop and start.`);
    return true;
}

/** Asks once per release before an interactive session; a declined version is not offered again. */
async function offerUpdate(store: LocalStore, values: Values): Promise<void> {
    if (flag(values, 'json') || flag(values, 'no-follow') || !process.stdin.isTTY || !process.stdout.isTTY) {
        return;
    }
    const latest = shouldOfferUpdate(store);
    if (!latest || !managedInstall()) {
        return;
    }
    const answer = await askYesNo(`PairLobby ${latest.version} is available (you have ${VERSION}). Update now? [y/N] `);
    if (!answer) {
        if (answer === false) {
            writeUpdateState(store, {dismissed: latest.version});
        }
        note('Not updated. Run pairlobby update whenever you want it.');
        return;
    }
    try {
        await installUpdate(store, latest);
    } catch (error) {
        note(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function updateCommand(store: LocalStore, values: Values): Promise<number> {
    if (flag(values, 'background')) {
        await runBackgroundUpdate(store);
        return 0;
    }
    const check = await checkForUpdate(store, true);
    if (flag(values, 'json') && !flag(values, 'yes')) {
        json({...check, managed: managedInstall() !== null});
        return 0;
    }
    if (!check.latest) {
        out('No PairLobby release is published on GitHub yet.');
        return 0;
    }
    if (!check.available) {
        out(`PairLobby ${check.current} is up to date.`);
        return 0;
    }
    out(`PairLobby ${check.latest.version} is available (you have ${check.current}): ${check.latest.pageUrl}`);
    if (flag(values, 'check')) {
        return 0;
    }
    if (!flag(values, 'yes')) {
        if (!process.stdin.isTTY) {
            note('Run pairlobby update --yes to install it.');
            return 0;
        }
        const answer = await askYesNo(`Install PairLobby ${check.latest.version} now? [y/N] `);
        if (!answer) {
            if (answer === false) {
                writeUpdateState(store, {dismissed: check.latest.version});
            }
            out('Not updated.');
            return 0;
        }
    }
    return (await installUpdate(store, check.latest)) ? 0 : 1;
}

function parsePublicUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new UsageError(`--public-url must be a full address such as https://laptop.tailnet.ts.net, not "${value}"`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new UsageError('--public-url must be an http(s) origin with no path, credentials, query or fragment');
    }
    return url.origin;
}

/** --lan or --tailscale on the command line, else --host alone (sharing as the address allows), else the device setting. */
function relayNetwork(store: LocalStore, values: Values): 'off' | 'tailscale' | 'lan' {
    if (flag(values, 'lan') && flag(values, 'tailscale')) {
        throw new UsageError('use either --lan or --tailscale, not both');
    }
    if (flag(values, 'lan')) {
        return 'lan';
    }
    if (flag(values, 'tailscale')) {
        return 'tailscale';
    }
    return str(values, 'host') !== undefined ? 'off' : store.settings().relayNetwork;
}

async function serve(store: LocalStore, values: Values): Promise<number> {
    const {startServer} = await import('@pairlobby/local-server');
    const {dataDirectory} = await import('@pairlobby/client');
    const {join} = await import('node:path');
    const dataDir = str(values, 'data-dir') ?? dataDirectory();
    const network = relayNetwork(store, values);
    const host = str(values, 'host') ?? (network === 'off' ? '127.0.0.1' : '0.0.0.0');
    const port = str(values, 'port') !== undefined ? Number(str(values, 'port')) : DEFAULT_RELAY_PORT;
    const publicUrl = str(values, 'public-url') !== undefined ? parsePublicUrl(str(values, 'public-url')!) : undefined;
    // Tailnet devices may address this one by its MagicDNS names, which are not interface addresses.
    const tailnet = host === '127.0.0.1' ? null : await tailscaleView();
    let running;
    try {
        running = await startServer({host, port, dataFile: join(dataDir, 'rooms.sqlite'), ...(publicUrl ? {publicUrl} : {}), peers: network === 'tailscale' ? 'tailscale' : 'any', hostnames: tailscaleNames(tailnet), advertise: network === 'lan'});
    } catch (error) {
        // Say what is wrong and what to do, rather than surfacing a raw errno. The
        // occupant is never probed: something else owning the port is not ours to poke.
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            throw new UsageError(
                `something is already listening on ${host}:${port}.\n  If it is your own PairLobby server, you do not need another one.\n  Otherwise pick a different port: pairlobby serve --port ${port + 1}`
            );
        }
        if ((error as NodeJS.ErrnoException).code === 'EACCES') {
            throw new UsageError(`not allowed to listen on ${host}:${port}; ports below 1024 usually need elevated permissions`);
        }
        throw error;
    }
    out(`PairLobby server on ${running.url}`);
    if (network !== 'off') {
        out(`Shared with: ${network === 'tailscale' ? 'this device and your Tailscale devices' : 'any device that can reach this one on the network'}`);
    }
    for (const url of running.shareUrls) {
        out(`Other devices: pairlobby join <code> --server ${url}`);
    }
    if (running.discoverable) {
        out(`On ${network === 'tailscale' ? 'your tailnet' : 'your network or tailnet'}, pairlobby join <code> finds this relay without --server.`);
    }
    if (network === 'tailscale' && running.shareUrls.length === 0) {
        note('no Tailscale address found; start Tailscale on this device, then restart the relay');
    } else if (network !== 'off' && running.shareUrls.length === 0) {
        note('no network address found; other devices cannot reach this server until this machine joins a network');
    }
    if (network !== 'tailscale' && running.shareUrls.some((url) => url.startsWith('http:'))) {
        note('Room traffic, including credentials, crosses the network unencrypted. Share on the local network only if you trust it; network-sharing tailscale keeps traffic inside Tailscale\'s encryption.');
    }
    out(`Data: ${running.dataFile}`);
    out('Press Ctrl+C to stop.');
    // Runs in the foreground: an auto-starting daemon is lifecycle complexity nobody has asked for yet.
    await new Promise<void>((resolve) => {
        const stop = () => {
            void running.close().then(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
    return 0;
}

/** Reminds a person at a terminal about a newer release once the command is done; never agents or scripts. */
function remindAboutUpdate(argv: string[]): void {
    if (!process.stderr.isTTY || argv.includes('--json') || ['update', 'receiver-run', 'receiver-tools', 'channel', 'guard-stop'].includes(argv[0] ?? '')) {
        return;
    }
    try {
        const store = new LocalStore();
        const notice = updateNotice(store);
        if (notice) {
            note(notice);
        }
        const invited = argv[0] === 'invitations' ? null : invitationNotice(store);
        if (invited) {
            note(invited);
        }
    } catch {
        // A reminder is never worth an error.
    }
}

void main(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code;
        remindAboutUpdate(process.argv.slice(2));
    })
    .catch((error: unknown) => {
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

//! `pairlobby share`: put one of your agents in the relay's agent directory, after showing
//! exactly what colleagues will see; `share --off` takes it out; `pairlobby shared` lists
//! what this device shares. Sharing exposes a room, so it is for a person at a terminal.

import {existsSync} from 'node:fs';
import {join} from 'node:path';

import type {LocalStore, RoomEntry, SessionEntry} from '@pairlobby/client';
import {ListingContact, ListingTopic, ProtocolError} from '@pairlobby/protocol';
import type {ListingConnection, ListingModel, ListingView} from '@pairlobby/protocol';

import {UsageError, hostedAccountToken, resolveRoom, select} from './context.js';
import {requireRelayFeature} from './doctor.js';
import {REFUSED} from './endpoints.js';
import {receiverConfiguration, receiverStatus} from './receiver.js';
import {json, out, relativeTime} from './render.js';
import {DEFAULT_SETUP} from './setup.js';
import {forgetListing, lastHeartbeat, saveListing, savedListing, savedListings} from './shared-listings.js';
import type {HeartbeatRecord, SavedListing} from './shared-listings.js';

export type ShareOptions = {
    room?: string | undefined;
    session?: string | undefined;
    topic?: string | undefined;
    contact?: string | undefined;
    off: boolean;
    yes: boolean;
    json: boolean;
};

export type ShareDeps = {
    /** A person is at a terminal that can answer a prompt. */
    interactive: boolean;
    /** This command runs inside an agent's session. */
    agent: boolean;
    ask: (question: string) => Promise<string>;
};

/** One row of `pairlobby shared`. */
export type SharedRow = SavedListing & {heartbeat: HeartbeatRecord | null};

/** What the receiver or channel listening for the agent will report, as `share` first sends it. */
type ListedAgent = {connection: ListingConnection; runtime?: string; model?: ListingModel};

/** The directory part of `receiver status`. */
export type ListingStatus = {listingId: string; topic: string; contact: ListingContact; lastHeartbeatAt: number | null; availability?: string; heartbeatError?: string};

export const SHARE_AGENT_REFUSAL = 'Sharing an agent in the directory is for a person at a terminal, not an agent session.';

const CONTACT_LINES: Record<ListingContact, string> = {
    questions: 'questions only; it answers read-only',
    tasks: 'questions and work, as if you had invited them',
};

const CONNECTION_LINES: Record<ListingConnection, string> = {
    separate: 'its managed receiver, a separate conversation in its project',
    original: 'your own Claude session, through the channel',
    manual: 'whenever the agent reads the room; nothing answers automatically',
};

export const DEFAULT_SHARE: ShareDeps = {
    interactive: process.stdin.isTTY === true,
    agent: false,
    ask: DEFAULT_SETUP.ask,
};

export async function shareCommand(store: LocalStore, options: ShareOptions, deps: ShareDeps = DEFAULT_SHARE): Promise<number> {
    if (deps.agent) {
        throw new UsageError(SHARE_AGENT_REFUSAL, REFUSED);
    }
    const room = resolveRoom(store, options.room);
    const session = agentSession(room, options.session);
    const {client, credential} = select(store, room.roomId, session.sessionId);
    if (!hostedAccountToken(store, room.serverUrl)) {
        throw new UsageError(`Sharing needs your personal login on ${room.serverUrl}: ask your relay admin for a personal token, then pairlobby login`);
    }
    const saved = savedListing(store, session.sessionId);
    if (options.off) {
        if (!saved) {
            throw new UsageError(`${session.displayName} is not shared from this device`);
        }
        try {
            await client.unshareListing(saved.listingId, credential);
        } catch (error) {
            // Already gone from the relay, with its room or by another device: only the local record is left.
            if (!(error instanceof ProtocolError && /no such listing/.test(error.message))) {
                throw error;
            }
        }
        forgetListing(store, session.sessionId);
        if (options.json) {
            json({listingId: saved.listingId, shared: false});
        } else {
            out(`Stopped sharing ${session.displayName}.`);
        }
        return 0;
    }
    const topic = ListingTopic.safeParse(options.topic ?? saved?.topic);
    if (!topic.success) {
        throw new UsageError(options.topic === undefined && !saved ? 'Say what the agent is working on: pairlobby share --topic "..."' : `The topic must be one line of plain text, at most 120 characters`);
    }
    const contact = ListingContact.safeParse(options.contact ?? saved?.contact ?? 'questions');
    if (!contact.success) {
        throw new UsageError('--contact is questions or tasks');
    }
    await requireRelayFeature(client, 'directory', 'the agent directory');
    const agent = listedAgent(store, session);
    if (!options.yes) {
        if (!deps.interactive) {
            throw new UsageError('pairlobby share asks for confirmation; run it in a terminal, or pass --yes after checking what it will show');
        }
        for (const line of sharePreview(room, session, topic.data, contact.data, agent)) {
            process.stderr.write(`${line}\n`);
        }
        const answer = (await deps.ask('Share it? [y/N] ')).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
            out('Not shared.');
            return 1;
        }
    }
    const listing = await client.shareListing(credential, {roomId: room.roomId, topic: topic.data, contact: contact.data, ...agent});
    saveListing(store, {listingId: listing.listingId, serverUrl: room.serverUrl, roomId: room.roomId, roomName: room.name, sessionId: session.sessionId, agentName: listing.agentName, topic: listing.topic, contact: listing.contact, connection: listing.connection, sharedAt: saved?.listingId === listing.listingId ? saved.sharedAt : Date.now()});
    if (options.json) {
        json({listing});
        return 0;
    }
    out(`${saved ? 'Updated' : 'Shared'} ${listing.agentName} in the directory as "${listing.topic}".`);
    out(availabilityNote(listing, agent.connection));
    out(`Stop with: pairlobby share --off --room ${room.roomId} --session ${session.sessionId}`);
    return 0;
}

/** What colleagues will see, and what contacting the agent gives them, shown before anything is saved. */
export function sharePreview(room: RoomEntry, session: SessionEntry, topic: string, contact: ListingContact, agent: ListedAgent): string[] {
    const model = agent.model ? `${agent.model.value}${agent.model.source === 'configured' ? ' (configured)' : ' (last reported)'}` : 'not known yet';
    return [
        `Colleagues on ${new URL(room.serverUrl).host} will see:`,
        `  Agent       ${session.displayName}`,
        `  Room        ${room.name}`,
        `  Topic       ${topic}`,
        `  Model       ${model}`,
        `  Contact     ${CONTACT_LINES[contact]}`,
        `  Answers     from ${CONNECTION_LINES[agent.connection]}`,
        `Colleagues who contact this agent join ${room.name} and can read its history.`,
        ...(agent.connection === 'original' && contact === 'questions' ? ['Its channel declines colleagues\' questions, because your own session cannot be limited to read-only answers. Start a managed receiver for it, or share with --contact tasks.'] : []),
    ];
}

export function sharedRows(store: LocalStore): SharedRow[] {
    return savedListings(store).map((listing) => ({...listing, heartbeat: lastHeartbeat(store, listing.sessionId)}));
}

export function sharedCommand(store: LocalStore, asJson: boolean, now = Date.now()): number {
    const rows = sharedRows(store);
    if (asJson) {
        json({listings: rows});
        return 0;
    }
    if (rows.length === 0) {
        out('This device shares no agents. Share one with: pairlobby share --topic "..."');
        return 0;
    }
    for (const row of rows) {
        out(`${row.agentName}  ${row.roomName}  "${row.topic}"  ${row.contact}  ${heartbeatLine(row.heartbeat, now)}`);
    }
    return 0;
}

/** The directory part of `receiver status`: absent when the agent is not shared. */
export function listingStatus(store: LocalStore, sessionId: string): ListingStatus | undefined {
    const listing = savedListing(store, sessionId);
    if (!listing) {
        return undefined;
    }
    const heartbeat = lastHeartbeat(store, sessionId);
    return {listingId: listing.listingId, topic: listing.topic, contact: listing.contact, lastHeartbeatAt: heartbeat?.sentAt ?? null, ...(heartbeat?.availability ? {availability: heartbeat.availability} : {}), ...(heartbeat?.error ? {heartbeatError: heartbeat.error} : {})};
}

export function heartbeatLine(heartbeat: HeartbeatRecord | null, now = Date.now()): string {
    if (heartbeat?.error) {
        return `heartbeat failing: ${heartbeat.error}`;
    }
    if (!heartbeat?.sentAt) {
        return 'no heartbeat yet';
    }
    return `${heartbeat.availability ?? 'seen'}, heartbeat ${relativeTime(heartbeat.sentAt, now)}`;
}

/** The session to share: the one named, else the room's only agent on this device. */
function agentSession(room: RoomEntry, reference?: string): SessionEntry {
    const wanted = reference ?? process.env['PAIRLOBBY_SESSION'];
    const agents = room.sessions.filter((session) => session.kind === 'agent');
    const session = wanted ? room.sessions.find((each) => each.sessionId === wanted || each.participantId === wanted) : agents.length === 1 ? agents[0] : undefined;
    if (!session) {
        if (wanted) {
            throw new UsageError(`no session "${wanted}" in room ${room.name}`);
        }
        throw new UsageError(agents.length === 0 ? `this device has no agent in ${room.name} to share` : `this device holds several agents in ${room.name}; pass --session with one of: ${agents.map((agent) => `${agent.displayName} (${agent.sessionId})`).join(', ')}`);
    }
    if (session.kind !== 'agent' || session.role === 'guest') {
        throw new UsageError(`${session.displayName} is not an agent member of ${room.name}; share puts an agent in the directory`);
    }
    return session;
}

/** How the agent will answer, from what listens for it on this device. */
function listedAgent(store: LocalStore, session: SessionEntry): ListedAgent {
    const config = receiverConfiguration(store, session.sessionId);
    const runtime = config?.runtime ?? session.runtime;
    const reported = config ? receiverStatus(store, session.sessionId)?.model : undefined;
    const configured = config?.model ?? session.model;
    const model: ListingModel | undefined = configured ? {value: configured, source: 'configured'} : reported ? {value: reported, source: 'reported'} : undefined;
    const channel = existsSync(join(store.directory, 'receivers', session.sessionId, 'channel.pid'));
    return {connection: channel ? 'original' : config ? 'separate' : 'manual', ...(runtime ? {runtime: runtime.slice(0, 32)} : {}), ...(model ? {model} : {})};
}

function availabilityNote(listing: ListingView, connection: ListingConnection): string {
    if (connection === 'manual') {
        return 'No receiver listens for this agent, so it shows as unknown until one starts; questions wait until the agent reads the room.';
    }
    return `It shows as ${listing.availability === 'unknown' ? 'available once its receiver sends a heartbeat, within a few seconds' : listing.availability}.`;
}

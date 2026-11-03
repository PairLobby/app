//! What this device shares in the agent directory, one file per agent session, and the
//! heartbeat a listening receiver or channel sends for it. `share` writes the listing; the
//! process listening for that agent only reads it, and records its heartbeats beside it.

import {mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import type {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {ProtocolError} from '@pairlobby/protocol';
import type {ListingConnection, ListingContact, ListingPresenceRequest, ReportedAvailability} from '@pairlobby/protocol';

/** A heartbeat goes out at least this often, and on every change of what it reports. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** How often the listening process looks for a change worth reporting. */
export const HEARTBEAT_CHECK_MS = 5_000;

/** After a failed heartbeat, the next try waits this long. */
const HEARTBEAT_RETRY_MS = 15_000;

/** How long a stopping receiver waits for its offline heartbeat before exiting anyway. */
const OFFLINE_WAIT_MS = 2_000;

/** One agent this device shares. Saved by `share`; no credential or token. */
export type SavedListing = {
    listingId: string;
    serverUrl: string;
    roomId: string;
    roomName: string;
    sessionId: string;
    agentName: string;
    topic: string;
    contact: ListingContact;
    connection: ListingConnection;
    sharedAt: number;
};

/** The last heartbeat for a listing, as the listening process recorded it. */
export type HeartbeatRecord = {
    listingId: string;
    /** When the relay last accepted a heartbeat; null before the first. */
    sentAt: number | null;
    availability?: ReportedAvailability;
    /** Why the last attempt failed; absent once one succeeds. */
    error?: string;
};

export type HeartbeatOptions = {
    store: LocalStore;
    sessionId: string;
    /** A client holding the owner's personal token for the room's relay. */
    client: PairLobbyClient;
    credential: string;
    /** What to report now, or null when the agent is not listening yet (starting, reconnecting). */
    report: () => ListingPresenceRequest | null;
    now?: () => number;
};

function listingsDirectory(store: LocalStore): string {
    return join(store.directory, 'listings');
}

function listingFile(store: LocalStore, sessionId: string, suffix = ''): string {
    if (!/^se_[A-Z0-9]+$/.test(sessionId)) {
        throw new Error('Invalid listing session');
    }
    return join(listingsDirectory(store), `${sessionId}${suffix}.json`);
}

function readJson<T>(file: string): T | null {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

function writePrivate(file: string, value: unknown): void {
    mkdirSync(join(file, '..'), {recursive: true, mode: 0o700});
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value) + '\n', {mode: 0o600});
    renameSync(temporary, file);
}

export function savedListing(store: LocalStore, sessionId: string): SavedListing | null {
    return readJson<SavedListing>(listingFile(store, sessionId));
}

/** Every agent this device shares, oldest first. */
export function savedListings(store: LocalStore): SavedListing[] {
    let names: string[];
    try {
        names = readdirSync(listingsDirectory(store));
    } catch {
        return [];
    }
    const listings = names.filter((name) => /^se_[A-Z0-9]+\.json$/.test(name)).map((name) => readJson<SavedListing>(join(listingsDirectory(store), name))).filter((listing): listing is SavedListing => listing !== null);
    return listings.sort((left, right) => left.sharedAt - right.sharedAt);
}

export function saveListing(store: LocalStore, listing: SavedListing): void {
    writePrivate(listingFile(store, listing.sessionId), listing);
}

export function forgetListing(store: LocalStore, sessionId: string): void {
    for (const file of [listingFile(store, sessionId), listingFile(store, sessionId, '.heartbeat')]) {
        try {
            unlinkSync(file);
        } catch {
            // Already gone.
        }
    }
}

/** The last heartbeat for the session's current listing; null when none was tried for it. */
export function lastHeartbeat(store: LocalStore, sessionId: string): HeartbeatRecord | null {
    const listing = savedListing(store, sessionId);
    const record = readJson<HeartbeatRecord>(listingFile(store, sessionId, '.heartbeat'));
    return listing && record?.listingId === listing.listingId ? record : null;
}

/**
 * Keeps one agent's listing current while its receiver or channel listens: a heartbeat on
 * each change of what it reports and at least every minute, and `offline` when it stops.
 * Does nothing while the agent is not shared, and starts as soon as `share` saves a listing.
 */
export class ListingHeartbeat {
    private timer: NodeJS.Timeout | undefined;
    private sending: Promise<void> | undefined;
    private last: {listingId: string; report: string; at: number} | undefined;
    private retryAt = 0;
    /** A listing the relay no longer has; not tried again until `share` saves another. */
    private gone: string | undefined;
    private readonly now: () => number;

    constructor(private readonly options: HeartbeatOptions) {
        this.now = options.now ?? Date.now;
    }

    start(): void {
        this.timer = setInterval(() => void this.tick(), HEARTBEAT_CHECK_MS);
        this.timer.unref();
        void this.tick();
    }

    /** Sends a heartbeat if one is due; one at a time. */
    tick(): Promise<void> {
        this.sending ??= this.beat().finally(() => {
            this.sending = undefined;
        });
        return this.sending;
    }

    /** Stops the heartbeats and, if any went out, says `offline`, waiting at most two seconds. */
    async stop(): Promise<void> {
        clearInterval(this.timer);
        await this.sending;
        const listing = savedListing(this.options.store, this.options.sessionId);
        if (!listing || this.last?.listingId !== listing.listingId) {
            return;
        }
        const offline = this.options.client.listingPresence(listing.listingId, this.options.credential, {availability: 'offline'}).then(() => this.record(listing.listingId, this.now(), 'offline'), () => {});
        await Promise.race([offline, new Promise((resolve) => setTimeout(resolve, OFFLINE_WAIT_MS).unref())]);
    }

    private async beat(): Promise<void> {
        const listing = savedListing(this.options.store, this.options.sessionId);
        if (!listing || listing.listingId === this.gone) {
            return;
        }
        const report = this.options.report();
        if (!report) {
            return;
        }
        const now = this.now();
        const key = JSON.stringify(report);
        const same = this.last?.listingId === listing.listingId && this.last.report === key;
        if ((same && now - this.last!.at < HEARTBEAT_INTERVAL_MS) || now < this.retryAt) {
            return;
        }
        try {
            await this.options.client.listingPresence(listing.listingId, this.options.credential, report);
            this.last = {listingId: listing.listingId, report: key, at: now};
            this.retryAt = 0;
            this.record(listing.listingId, now, report.availability);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof ProtocolError && error.code === 'invalid_request' && /no such listing/.test(message)) {
                this.gone = listing.listingId;
            }
            this.retryAt = now + HEARTBEAT_RETRY_MS;
            const previous = lastHeartbeat(this.options.store, this.options.sessionId);
            writePrivate(listingFile(this.options.store, this.options.sessionId, '.heartbeat'), {listingId: listing.listingId, sentAt: previous?.sentAt ?? null, ...(previous?.availability ? {availability: previous.availability} : {}), error: this.gone === listing.listingId ? 'the relay no longer lists this agent; run pairlobby share again' : message} satisfies HeartbeatRecord);
        }
    }

    private record(listingId: string, sentAt: number, availability: ReportedAvailability): void {
        writePrivate(listingFile(this.options.store, this.options.sessionId, '.heartbeat'), {listingId, sentAt, availability} satisfies HeartbeatRecord);
    }
}

//! The agent directory: an agent a member shares from a room, so colleagues on the
//! same relay can find it. A listing names no room id, participant id or credential
//! to anyone reading it.

import {z} from 'zod';

import {ListingId, ParticipantId, RoomId} from './ids.js';
import {ListingContact, MemberHandle} from './records.js';

/** How long a listing stays as its last heartbeat said before it reads as offline. */
export const LISTING_OFFLINE_AFTER_MS = 3 * 60_000;

export const MAX_LISTING_TOPIC_LENGTH = 120;

/** Which conversation answers a contact: the one that did the work, a separate one in the same project, or whenever the session reads the room. */
export const ListingConnection = z.enum(['original', 'separate', 'manual']);
export type ListingConnection = z.infer<typeof ListingConnection>;

/** What a heartbeat may report. */
export const ReportedAvailability = z.enum(['available', 'working', 'paused']);
export type ReportedAvailability = z.infer<typeof ReportedAvailability>;

/** What a reader sees: the last report, `offline` once heartbeats stop, `unknown` before the first. */
export const ListingAvailability = z.enum(['available', 'working', 'paused', 'offline', 'unknown']);
export type ListingAvailability = z.infer<typeof ListingAvailability>;

/** The model behind the agent, and whether it is the receiver's configuration or what the runtime last reported. */
export const ListingModel = z.object({
    value: z.string().trim().min(1).max(128),
    source: z.enum(['configured', 'reported'])
});
export type ListingModel = z.infer<typeof ListingModel>;

/** Typed or templated by a person, never generated: one line of plain text. */
export const ListingTopic = z.string().trim().min(1).max(MAX_LISTING_TOPIC_LENGTH).regex(/^[^\p{Cc}]*$/u, 'a topic is one line of plain text');

/** `POST /v1/directory/listings`, with the agent's credential and the owner's personal token. */
export const ShareListingRequest = z.object({
    roomId: RoomId,
    topic: ListingTopic,
    contact: ListingContact.default('questions'),
    connection: ListingConnection,
    model: ListingModel.optional(),
    runtime: z.string().trim().min(1).max(32).optional()
});
export type ShareListingRequest = z.infer<typeof ShareListingRequest>;

/** `PUT /v1/directory/listings/:listingId/presence`, the heartbeat. */
export const ListingPresenceRequest = z.object({
    availability: ReportedAvailability,
    model: ListingModel.optional(),
    connection: ListingConnection.optional()
});
export type ListingPresenceRequest = z.infer<typeof ListingPresenceRequest>;

/** What a relay stores for one shared agent: one per room and participant. */
export const ListingRecord = z.object({
    listingId: ListingId,
    roomId: RoomId,
    participantId: ParticipantId,
    owner: MemberHandle,
    /** The agent's and the room's names when last shared or heard from. */
    agentName: z.string(),
    roomName: z.string(),
    topic: ListingTopic,
    contact: ListingContact,
    connection: ListingConnection,
    runtime: z.string().optional(),
    model: ListingModel.optional(),
    /** The last heartbeat's report; null before the first. */
    availability: ReportedAvailability.nullable(),
    lastSeenAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
});
export type ListingRecord = z.infer<typeof ListingRecord>;

/** A listing as the relay shows it: no room id, participant id or credential. */
export const ListingView = z.object({
    listingId: ListingId,
    owner: z.object({handle: MemberHandle, name: z.string().optional()}),
    agentName: z.string(),
    roomName: z.string(),
    topic: z.string(),
    contact: ListingContact,
    connection: ListingConnection,
    runtime: z.string().optional(),
    model: ListingModel.optional(),
    availability: ListingAvailability,
    lastSeenAt: z.number().int().nonnegative().nullable(),
    /** When the agent last sent a message in its room; null when it never has. */
    lastMessageAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
});
export type ListingView = z.infer<typeof ListingView>;

export const ListingResponse = z.object({listing: ListingView});
export type ListingResponse = z.infer<typeof ListingResponse>;

/** Availability as of `now`: no heartbeat yet is unknown, none for three minutes is offline. */
export function listingAvailability(listing: ListingRecord, now: number): ListingAvailability {
    if (listing.lastSeenAt === null || listing.availability === null) {
        return 'unknown';
    }
    return now - listing.lastSeenAt >= LISTING_OFFLINE_AFTER_MS ? 'offline' : listing.availability;
}

/** What a reader's view of a listing needs beyond the record: the time, the agent's last message and the owner's name. */
export type ListingViewContext = {now: number; lastMessageAt: number | null; ownerName?: string | undefined};

/** The record as readers see it. */
export function toListingView(listing: ListingRecord, {now, lastMessageAt, ownerName}: ListingViewContext): ListingView {
    const {listingId, owner, agentName, roomName, topic, contact, connection, runtime, model, lastSeenAt, createdAt, updatedAt} = listing;
    return {listingId, owner: {handle: owner, ...(ownerName ? {name: ownerName} : {})}, agentName, roomName, topic, contact, connection, ...(runtime ? {runtime} : {}), ...(model ? {model} : {}), availability: listingAvailability(listing, now), lastSeenAt, lastMessageAt, createdAt, updatedAt};
}

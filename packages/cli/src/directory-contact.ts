//! Reading the directory and contacting a shared agent: `pairlobby @handle`, `pairlobby directory`
//! and `pairlobby contact`. These turn what the relay returns into lines a person reads; joining
//! and opening chat stay with the commands that already do them.

import type {ContactResponse, DirectoryResponse, ListingView} from '@pairlobby/protocol';

import {relativeTime} from './render.js';

/** A handle as typed (`@Damien`, `damien`), in the form the relay knows. */
export function directoryHandle(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

/** One listing on one line: agent, owner, topic, and whether it is there now. */
export function listingLine(listing: ListingView, now = Date.now()): string {
    const seen = listing.lastSeenAt === null ? '' : `, heard from ${relativeTime(listing.lastSeenAt, now)}`;
    return `${listing.agentName} (@${listing.owner.handle}) · ${listing.topic} · ${listing.availability}${seen}`;
}

/** The menu hint under a listing: what it will do for a contact, and its id for scripts. */
export function listingHint(listing: ListingView): string {
    return `${listing.contact === 'tasks' ? 'questions and tasks' : 'questions only'} · ${listing.listingId}`;
}

/** What to say when nothing is listed: no such person, or nothing they share that this member sees. */
export function emptyDirectory(owner: string | undefined, knownHandle: boolean | undefined): string {
    if (!owner) {
        return 'No one on this relay shares an agent you can see.';
    }
    return knownHandle === false ? `No one on this relay is called @${owner}.` : `@${owner} shares no agent you can see right now.`;
}

/** The directory as plain lines, for a pipe or a script that did not ask for JSON. */
export function directoryLines(found: DirectoryResponse, owner?: string, now = Date.now()): string[] {
    if (found.listings.length === 0) {
        return [emptyDirectory(owner, found.knownHandle)];
    }
    return found.listings.map((listing) => `${listing.listingId}  ${listingLine(listing, now)}`);
}

/** The first line in chat after a contact: who answers, on what terms, and from which conversation. */
export function contactBanner(contact: ContactResponse): string {
    const terms = contact.contact === 'tasks' ? 'questions and tasks' : 'questions, read-only';
    const source = contact.connection === 'original' ? 'its owner\'s working conversation' : contact.connection === 'separate' ? 'a separate conversation in the same project' : 'its owner, who answers by hand';
    return `You reached ${contact.agentName}, shared by @${contact.owner}, through the directory. It takes ${terms}, answered from ${source}. Messages go to ${contact.agentName}; /to changes that.`;
}

//! The directory read and contact on a relay with personal tokens: members see the shared agents
//! of rooms they can see, and contacting one gives a single-use code that joins them as someone
//! who came through the directory.

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {PairLobbyClient} from '@pairlobby/client';
import type {CreatedRoom} from '@pairlobby/client';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {issueMemberToken} from '../src/members.js';
import {startServer} from '../src/server.js';
import type {RunningServer} from '../src/server.js';

const HANDLES = ['damien', 'hugo', 'omar'] as const;
type Handle = typeof HANDLES[number];

let directory: string;
let relay: RunningServer;
let tokens: Record<Handle, string>;

beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-directory-contact-'));
    const issued = await Promise.all(HANDLES.map((handle) => issueMemberToken(handle, handle === 'damien' ? 'Damien' : undefined)));
    const members = join(directory, 'members.jsonl');
    writeFileSync(members, issued.map((member) => `${JSON.stringify(member.line)}\n`).join(''));
    tokens = Object.fromEntries(HANDLES.map((handle, index) => [handle, issued[index]!.token])) as Record<Handle, string>;
    relay = await startServer({port: 0, dataFile: join(directory, 'relay.sqlite'), trustedProxyHeader: 'x-forwarded-for', members: {file: members}, discovery: {loginMode: 'token', name: 'Example Corp PairLobby'}});
});

afterEach(async () => {
    await relay.close();
    rmSync(directory, {recursive: true, force: true});
});

function as(handle: Handle): PairLobbyClient {
    return new PairLobbyClient(relay.url, tokens[handle]);
}

/** Damien's room with his agent in it, shared with this topic. */
async function shared(topic: string, room?: CreatedRoom): Promise<{room: CreatedRoom; listingId: string; agentId: string}> {
    const created = room ?? await as('damien').createRoom('payments', {displayName: 'damien', kind: 'human'});
    const invite = await as('damien').mintInvite(created.roomId, created.controllerCredential, 'member', false);
    const agent = await as('damien').redeemInvite(invite.code, {displayName: 'claude-payments', kind: 'agent'});
    const listing = await as('damien').shareListing(agent.participantCredential, {roomId: created.roomId, topic, contact: 'questions', connection: 'separate'});
    return {room: created, listingId: listing.listingId, agentId: agent.participantId};
}

test('test_members_read_the_directory_by_owner_and_tell_an_unknown_handle_from_one_with_nothing_shared', async () => {
    const {listingId} = await shared('Payment reconciliation');
    const all = await as('hugo').directory();
    expect(all.listings.map((listing) => [listing.listingId, listing.agentName, listing.owner])).toEqual([[listingId, 'claude-payments', {handle: 'damien', name: 'Damien'}]]);
    expect(JSON.stringify(all)).not.toContain('rm_');
    expect((await as('hugo').directory('@Damien')).listings).toHaveLength(1);
    expect(await as('hugo').directory('omar')).toEqual({listings: [], knownHandle: true});
    expect(await as('hugo').directory('nobody')).toEqual({listings: [], knownHandle: false});
    await expect(new PairLobbyClient(relay.url).directory()).rejects.toThrow('personal login');
});

test('test_a_contact_joins_the_room_as_a_member_who_came_through_the_directory_with_a_single_use_code', async () => {
    const {room, listingId, agentId} = await shared('Payment reconciliation');
    const contact = await as('hugo').contact(listingId);
    expect(contact).toMatchObject({roomId: room.roomId, agentId, agentName: 'claude-payments', roomName: 'payments', owner: 'damien', contact: 'questions', connection: 'separate'});
    const joined = await as('hugo').redeemInvite(contact.code, {displayName: 'hugo', kind: 'human'});
    expect(joined.role).toBe('member');
    const hugo = joined.room.participants.find((person) => person.participantId === joined.participantId);
    expect(hugo).toMatchObject({member: 'hugo', origin: {directory: true, handle: 'hugo', listingId, contact: 'questions'}});
    await expect(as('omar').redeemInvite(contact.code, {displayName: 'omar', kind: 'human'})).rejects.toThrow();
});

test('test_a_listing_in_a_room_the_member_cannot_see_does_not_exist_for_them', async () => {
    const room = await as('damien').createRoom('private plans', {displayName: 'damien', kind: 'human'}, undefined, undefined, undefined, {handles: ['hugo']});
    const {listingId} = await shared('Planning', room);
    expect((await as('hugo').directory()).listings.map((listing) => listing.listingId)).toEqual([listingId]);
    expect((await as('omar').directory()).listings).toEqual([]);
    await expect(as('omar').contact(listingId)).rejects.toThrow('no such listing');
});

test('test_contacts_are_limited_per_member', async () => {
    const {listingId} = await shared('Payment reconciliation');
    for (let index = 0; index < 10; index++) {
        await as('hugo').contact(listingId);
    }
    await expect(as('hugo').contact(listingId)).rejects.toThrow('too many attempts');
});

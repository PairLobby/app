//! Finding the relay behind a bare invite code, so `pairlobby join K7MP-4QWX`
//! works on another device without `--server`.
//!
//! An invite code means something only to the relay that issued it. This asks the
//! relays this device can see: its own, those announced on the local network over
//! mDNS, and the online devices on its tailnet at the default port. Each is sent
//! only the first digits of the code's digest (`inviteProbe`), never the code, so
//! a relay that is not the right one learns too little to use it. The code itself
//! goes only to the one relay that recognizes it; when several claim it, nothing is
//! sent and the person picks with --server.

import {PairLobbyClient, type InviteProbeResult} from '@pairlobby/client';
import {inviteProbe, normalizeInviteCode} from '@pairlobby/protocol';
import type {LocalRoom} from '@pairlobby/protocol';

import {DEFAULT_LOCAL_SERVER, DEFAULT_RELAY_PORT, UsageError} from './context.js';
import {tailscaleView} from './tailscale.js';

export type RelayCandidate = {
    url: string;
    /** Where it was found, for messages: a device name or "local network". */
    label: string;
};

export type DiscoveryDeps = {
    local: string;
    /** Relays announced on the local network. */
    lan: () => Promise<RelayCandidate[]>;
    /** Relays that may be listening on tailnet devices. */
    tailnet: () => Promise<RelayCandidate[]>;
    probe: (url: string, probe: string) => Promise<InviteProbeResult>;
};

export const DEFAULT_DISCOVERY: DiscoveryDeps = {
    local: DEFAULT_LOCAL_SERVER,
    lan: async () => {
        // Loaded on demand like `serve` does, so ordinary commands never load the relay's SQLite.
        const {browseRelays} = await import('@pairlobby/local-server');
        return (await browseRelays(1500)).map((url) => ({url, label: 'local network'}));
    },
    tailnet: async () => {
        const view = await tailscaleView();
        if (!view) {
            return [];
        }
        // IPv4 only: a bracketed IPv6 URL works too, but one address per device is enough.
        return view.peers.filter((peer) => peer.online).flatMap((peer) => peer.addresses.filter((address) => address.includes('.')).slice(0, 1).map((address) => ({url: `http://${address}:${DEFAULT_RELAY_PORT}`, label: peer.name})));
    },
    probe: (url, probe) => new PairLobbyClient(url).probeInvite(probe),
};

/** The relay that issued `code`, or a UsageError that says what was searched. */
export async function findRelayForInvite(code: string, deps: DiscoveryDeps = DEFAULT_DISCOVERY): Promise<string> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) {
        // Not a code at all: let this device's relay give the usual error.
        return deps.local;
    }
    const probe = await inviteProbe(normalized);
    const [local, lan, tailnet] = await Promise.all([deps.probe(deps.local, probe), deps.lan(), deps.tailnet()]);
    if (local === 'known') {
        return deps.local;
    }
    const candidates = [...new Map([...lan, ...tailnet].map((candidate) => [candidate.url, candidate])).values()];
    const results = await Promise.all(candidates.map(async (candidate) => ({...candidate, result: await deps.probe(candidate.url, probe)})));
    const known = results.filter((candidate) => candidate.result === 'known');
    if (known.length === 1) {
        return known[0]!.url;
    }
    if (known.length > 1) {
        throw new UsageError(`more than one relay could have issued ${code}, so the code was not sent to any:\n${known.map((candidate) => `  pairlobby join ${code} --server ${candidate.url}   (${candidate.label})`).join('\n')}\nAsk whoever invited you which one, and pick it with --server.`);
    }
    // A relay from before invite probes cannot say; this device's own is the old default.
    if (local === 'unsupported') {
        return deps.local;
    }
    const answered = results.filter((candidate) => candidate.result !== 'unreachable');
    const searched = [`this device${local === 'unreachable' ? ' (no relay running)' : ''}`, `${lan.length} on the local network`, `${tailnet.length} Tailscale device(s), ${answered.filter((candidate) => tailnet.some((peer) => peer.url === candidate.url)).length} with a relay`];
    throw new UsageError(`no relay this device can see issued ${code} (searched ${searched.join(', ')}).\nAsk for the full join command, which names the relay with --server, or pass --server <address>. A relay is found automatically only when its owner shares it (pairlobby settings network-sharing) on port ${DEFAULT_RELAY_PORT} or on the local network.`);
}

export type LocalRoomMatch = RelayCandidate & {room: LocalRoom};

export type LocalRoomDeps = Omit<DiscoveryDeps, 'probe'> & {
    /** Rooms open to the local network on one relay with this name; null when it cannot say. */
    lookup: (url: string, name: string) => Promise<LocalRoom[] | null>;
};

export const DEFAULT_LOCAL_ROOMS: LocalRoomDeps = {
    local: DEFAULT_DISCOVERY.local,
    lan: DEFAULT_DISCOVERY.lan,
    tailnet: DEFAULT_DISCOVERY.tailnet,
    lookup: (url, name) => new PairLobbyClient(url).localRooms(name),
};

/**
 * The one room named `name` that is open to the local network, on this device's
 * relay, a relay announced on the local network, or a tailnet device. Names are not
 * unique, so several matches are listed for the person to pick by room id.
 */
export async function findLocalRoom(name: string, deps: LocalRoomDeps = DEFAULT_LOCAL_ROOMS, only?: string): Promise<LocalRoomMatch> {
    const candidates = only ? [{url: only, label: only}] : [{url: deps.local, label: 'this device'}, ...(await Promise.all([deps.lan(), deps.tailnet()])).flat()];
    const unique = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()];
    const answers = await Promise.all(unique.map(async (candidate) => ({...candidate, rooms: await deps.lookup(candidate.url, name)})));
    const matches = answers.flatMap((answer) => (answer.rooms ?? []).map((room) => ({url: answer.url, label: answer.label, room})));
    if (matches.length === 1) {
        return matches[0]!;
    }
    if (matches.length > 1) {
        throw new UsageError(`more than one room named "${name}" is open to the local network; pick one:\n${matches.map((match) => `  pairlobby join local ${match.room.roomId} --server ${match.url}   (${match.label}, ${match.room.participantCount} in the room, created ${new Date(match.room.createdAt).toLocaleString()})`).join('\n')}`);
    }
    const asked = answers.filter((answer) => answer.rooms !== null).length;
    throw new UsageError(`no room named "${name}" is open to the local network on the ${asked} relay(s) that answered${only ? '' : ` (of ${unique.length} this device can see)`}.\nIf this was an invite code, check it; otherwise the room's owner can open it with: pairlobby open-local <room>`);
}

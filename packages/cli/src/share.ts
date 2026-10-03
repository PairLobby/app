//! Turning a room's saved server address into a join command another device can use.
//!
//! The device running a local server saves its rooms under loopback, which means
//! nothing to any other machine. The server itself knows which addresses it
//! listens on, so ask it rather than guessing from this machine's interfaces.

import {PairLobbyClient} from '@pairlobby/client';

import {UsageError} from './context.js';

export type ShareTarget = {
    /** The server address another device should use. */
    serverUrl: string;
    /** True when only the device running the server can reach it. */
    localOnly: boolean;
    /** Set on a local-only target that is not `pairlobby serve`, so `--lan` cannot widen it. */
    otherRelay?: true;
    /** Set when devices on the same network or tailnet can join with the bare code. */
    discoverable?: true;
};

export type JoinLink = {
    serverUrl: string;
    code: string;
};

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

export function isLoopbackUrl(serverUrl: string): boolean {
    return LOOPBACK.includes(new URL(serverUrl).hostname);
}

export function isHostedUrl(serverUrl: string): boolean {
    return new URL(serverUrl).pathname.startsWith('/relay/');
}

export async function shareTarget(serverUrl: string): Promise<ShareTarget> {
    if (!isLoopbackUrl(serverUrl)) {
        return {serverUrl, localOnly: false};
    }
    let shareUrls: string[] = [];
    let reported = true;
    let discoverable = false;
    try {
        ({shareUrls, reported, discoverable} = await new PairLobbyClient(serverUrl).serverInfo());
    } catch {
        // An unreachable server has already failed the command that minted the invite.
    }
    if (shareUrls.length > 0) {
        return discoverable ? {serverUrl: shareUrls[0]!, localOnly: false, discoverable: true} : {serverUrl: shareUrls[0]!, localOnly: false};
    }
    return reported ? {serverUrl, localOnly: true} : {serverUrl, localOnly: true, otherRelay: true};
}

export async function joinCommand(serverUrl: string, code: string): Promise<{command: string; target: ShareTarget}> {
    if (isHostedUrl(serverUrl)) {
        return {command: `pairlobby join online ${code}`, target: {serverUrl, localOnly: false}};
    }
    const target = await shareTarget(serverUrl);
    return {command: `pairlobby join ${code} --server ${target.serverUrl}`, target};
}

export function discoverableNote(code: string): string {
    return `on a device on the same network or tailnet, pairlobby join ${code} is enough`;
}

export function localOnlyNote(target: ShareTarget): string {
    if (target.otherRelay) {
        return `Only this device can reach ${target.serverUrl}. Other devices need an address of this relay they can reach, such as its network address or public URL.`;
    }
    return `Only this device can reach ${target.serverUrl}. To invite your other devices, share this relay: pairlobby settings network-sharing tailscale (or lan), then restart it`;
}

/** Accepts `http://10.0.0.5:8790#K7MP-4QWX`, a server address with the invite code as its fragment. */
export function parseJoinLink(value: string): JoinLink | null {
    if (!/^https?:\/\//i.test(value)) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new UsageError(`"${value}" is not a valid join link`);
    }
    const code = decodeURIComponent(url.hash.slice(1)).trim();
    if (!code) {
        throw new UsageError('a join link needs the invite code after #, for example http://10.0.0.5:8790#K7MP-4QWX');
    }
    url.hash = '';
    return {serverUrl: url.href.replace(/\/+$/, ''), code};
}

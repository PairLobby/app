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
    try {
        shareUrls = (await new PairLobbyClient(serverUrl).serverInfo()).shareUrls;
    } catch {
        // An unreachable server has already failed the command that minted the invite.
    }
    return shareUrls.length > 0 ? {serverUrl: shareUrls[0]!, localOnly: false} : {serverUrl, localOnly: true};
}

export async function joinCommand(serverUrl: string, code: string): Promise<{command: string; target: ShareTarget}> {
    if (isHostedUrl(serverUrl)) {
        return {command: `pairlobby join online ${code}`, target: {serverUrl, localOnly: false}};
    }
    const target = await shareTarget(serverUrl);
    return {command: `pairlobby join ${code} --server ${target.serverUrl}`, target};
}

export function localOnlyNote(serverUrl: string): string {
    return `Only this device can reach ${serverUrl}. To invite another device on your network, restart the server with: pairlobby serve --lan`;
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

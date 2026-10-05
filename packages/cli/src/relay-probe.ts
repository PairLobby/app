//! One short question to a relay that may not be there: an HTTP GET that gives up
//! completely when its time is up.
//!
//! `fetch` with a timeout rejects on time, but a connection attempt to a device
//! that silently drops packets (a firewalled machine on the tailnet) stays open for
//! about ten more seconds and keeps the process from exiting. Here the socket is
//! destroyed with the request, so a command that searched the network ends at once.

import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';

import {PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER} from '@pairlobby/protocol';
import type {LocalRoom} from '@pairlobby/protocol';
import type {InviteProbeResult} from '@pairlobby/client';

export type RelayAnswer = {status: number; body: unknown};

const MAX_ANSWER_BYTES = 1024 * 1024;

/** The relay's JSON answer, or null when it cannot be reached in time, was aborted, or did not send JSON. */
export function askRelay(url: string, timeoutMs = 1500, signal?: AbortSignal): Promise<RelayAnswer | null> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);
            return;
        }
        let settled = false;
        const settle = (answer: RelayAnswer | null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abandon);
            request.destroy();
            resolve(answer);
        };
        const abandon = () => settle(null);
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            resolve(null);
            return;
        }
        const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {method: 'GET', headers: {[PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION)}, agent: false}, (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_ANSWER_BYTES) {
                    settle(null);
                    return;
                }
                chunks.push(chunk);
            });
            response.on('error', abandon);
            response.on('end', () => {
                try {
                    settle({status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown});
                } catch {
                    settle(null);
                }
            });
        });
        // One deadline for connecting and answering; destroying the request closes the socket with it.
        const timer = setTimeout(abandon, timeoutMs);
        signal?.addEventListener('abort', abandon, {once: true});
        request.on('error', abandon);
        request.end();
    });
}

/** Whether this relay issued an invite whose digest starts with `probe`; see `inviteProbe`. */
export async function probeRelayForInvite(url: string, probe: string, signal?: AbortSignal): Promise<InviteProbeResult> {
    const answer = await askRelay(`${url}/v1/invites/probe?prefix=${encodeURIComponent(probe)}`, 1500, signal);
    if (!answer) {
        return 'unreachable';
    }
    if (answer.status === 404) {
        return 'unsupported';
    }
    if (answer.status < 200 || answer.status > 299) {
        return 'unreachable';
    }
    return (answer.body as {known?: unknown} | null)?.known === true ? 'known' : 'unknown';
}

/**
 * Rooms on this relay open to its local network: those named `name`, or all of
 * them without one. Null when the relay cannot say: unreachable, older than this
 * question, or not counting this device as local.
 */
export async function relayLocalRooms(url: string, name?: string, signal?: AbortSignal): Promise<LocalRoom[] | null> {
    const answer = await askRelay(`${url}/v1/rooms/local${name === undefined ? '' : `?name=${encodeURIComponent(name)}`}`, 1500, signal);
    if (!answer || answer.status < 200 || answer.status > 299) {
        return null;
    }
    const rooms = (answer.body as {rooms?: unknown} | null)?.rooms;
    return Array.isArray(rooms) ? (rooms as LocalRoom[]) : null;
}

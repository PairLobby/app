//! One JSON line per request, for a relay run as a service: what was asked, how it
//! ended and how long it took, never a body, a credential, an invite code or a name.

import {createHash, randomUUID} from 'node:crypto';

/** `all` logs every request; `writes` skips successful reads, which clients repeat every second while they wait. */
export type RequestLogMode = 'all' | 'writes';

export const REQUEST_LOG_MODES: readonly RequestLogMode[] = ['all', 'writes'];

export type RequestLogOptions = {
    mode: RequestLogMode;
    /** Receives each line; a service writes it to standard output for its log collector. */
    write: (line: string) => void;
};

export type RequestLogLine = {
    ts: string;
    level: 'info' | 'warn';
    event: 'request';
    requestId: string;
    method: string;
    route: string;
    status: number;
    ms: number;
    roomHash?: string;
};

type RequestLogEntry = {requestId: string; method: string; path: string; status: number; ms: number; at: Date};

export const REQUEST_ID_HEADER = 'x-request-id';

const IDENTIFIER = /^[a-z]{2}_[0-9A-Z]{20,32}$/;

/** The caller's request id when it is a short plain token, else a new one; a caller cannot inject text into the log. */
export function requestIdFor(offered: string | null): string {
    return offered && /^[A-Za-z0-9._-]{1,64}$/.test(offered) ? offered : randomUUID();
}

/** The path with every identifier replaced, so lines group by route and carry no room, file or request id. */
export function routePattern(path: string): string {
    const segments = path.split('/').filter(Boolean).map((segment, index, all) => {
        if (index === 2 && all[0] === 'v1' && all[1] === 'rooms' && segment !== 'local') {
            return ':room';
        }
        return IDENTIFIER.test(segment) ? ':id' : segment;
    });
    return `/${segments.join('/')}`;
}

/** The first eight hex digits of the room id's SHA-256: enough to follow one room through the log, not to find it. */
export function roomHashOf(path: string): string | undefined {
    const segments = path.split('/').filter(Boolean);
    if (segments[0] !== 'v1' || segments[1] !== 'rooms' || !segments[2] || segments[2] === 'local') {
        return undefined;
    }
    return createHash('sha256').update(segments[2]).digest('hex').slice(0, 8);
}

export function shouldLog(mode: RequestLogMode, method: string, status: number): boolean {
    return mode === 'all' || status >= 400 || !['GET', 'HEAD'].includes(method);
}

export function requestLogLine({requestId, method, path, status, ms, at}: RequestLogEntry): string {
    const roomHash = roomHashOf(path);
    const line: RequestLogLine = {ts: at.toISOString(), level: status >= 500 ? 'warn' : 'info', event: 'request', requestId, method, route: routePattern(path), status, ms, ...(roomHash ? {roomHash} : {})};
    return JSON.stringify(line);
}

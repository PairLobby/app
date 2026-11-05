//! Personal tokens on a self-hosted relay. The members file holds one JSON line per
//! person, `{"handle":"damien","name":"Damien","tokenSha256":"..."}`, and never a token.
//! The relay rereads it when it changes, so adding or removing a line needs no restart,
//! and a broken file keeps the members it had.

import {randomBytes} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';

import {MemberHandle, hashCredential} from '@pairlobby/protocol';
import type {MemberLookup, RelayMember} from '@pairlobby/server-core';

/** What a personal token starts with, so one is easy to tell from a team token or an account token. */
export const MEMBER_TOKEN_PREFIX = 'plm_';

/** How often the relay looks at the file's modification time. */
export const MEMBERS_RELOAD_MS = 60_000;

/** Handles that would read as something else in a room, such as `@all`, or as the service. */
const RESERVED_HANDLES = new Set(['admin', 'all', 'everyone', 'guest', 'here', 'me', 'owner', 'pairlobby', 'root', 'system', 'team', 'claude', 'codex', 'qwen']);

/** One line of the members file. */
export type MemberLine = {handle: string; name?: string; tokenSha256: string};

/** A members file the relay cannot use; the message names the line, never its content. */
export class MembersFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MembersFileError';
    }
}

/** Lowercases and strips a leading `@`; null unless the result is a handle a member may have. */
export function memberHandle(value: string): string | null {
    const handle = value.trim().replace(/^@/, '').toLowerCase();
    return MemberHandle.safeParse(handle).success && !RESERVED_HANDLES.has(handle) ? handle : null;
}

/** The members by token digest. Blank lines are skipped; a handle or a digest used twice is refused. */
export function parseMembers(text: string): Map<string, RelayMember> {
    const members = new Map<string, RelayMember>();
    const handles = new Set<string>();
    const lines = text.split('\n');
    for (const [index, raw] of lines.entries()) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        const where = `line ${index + 1} of the members file`;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            throw new MembersFileError(`${where} is not JSON`);
        }
        const {handle, name, tokenSha256} = (parsed ?? {}) as Partial<Record<keyof MemberLine, unknown>>;
        const checked = typeof handle === 'string' ? memberHandle(handle) : null;
        if (!checked || checked !== handle) {
            throw new MembersFileError(`${where} needs a handle of 3 to 30 lowercase letters, digits, - and _, not a reserved one`);
        }
        if (typeof tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tokenSha256)) {
            throw new MembersFileError(`${where} needs tokenSha256, the token's SHA-256 in lowercase hex`);
        }
        if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\x00-\x1f\x7f]/.test(name))) {
            throw new MembersFileError(`${where} has a name that is not plain text of at most 64 characters`);
        }
        if (handles.has(checked) || members.has(tokenSha256)) {
            throw new MembersFileError(`${where} repeats a handle or a token already in the file`);
        }
        handles.add(checked);
        members.set(tokenSha256, {handle: checked, ...(typeof name === 'string' ? {name: name.trim()} : {})});
    }
    return members;
}

/** A fresh personal token. */
export function newMemberToken(): string {
    return MEMBER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export type IssuedMember = {token: string; line: MemberLine};

/** A token for `handle` and the line that admits it; the relay stores only the line. */
export async function issueMemberToken(handle: string, name?: string): Promise<IssuedMember> {
    const checked = memberHandle(handle);
    if (!checked) {
        throw new MembersFileError(`"${handle}" is not a handle a member may have: 3 to 30 lowercase letters, digits, - and _, not a reserved one`);
    }
    const token = newMemberToken();
    const trimmed = name?.trim();
    return {token, line: {handle: checked, ...(trimmed ? {name: trimmed} : {}), tokenSha256: await hashCredential(token)}};
}

export type MembersFileOptions = {
    path: string;
    /** One JSON line per reload outcome; never a handle list or a token. */
    log?: (line: string) => void;
    reloadMs?: number;
};

/** The members file as the relay sees it: read once at start, then again when its modification time or size changes. */
export class MembersFile {
    private members: Map<string, RelayMember>;
    private stamp: string;
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly options: MembersFileOptions) {
        this.members = parseMembers(this.read());
        this.stamp = this.currentStamp();
    }

    readonly lookup: MemberLookup = async (digest) => this.members.get(digest) ?? null;

    /** The member with this handle, or null. */
    readonly byHandle = (handle: string): RelayMember | null => [...this.members.values()].find((member) => member.handle === handle) ?? null;

    get size(): number {
        return this.members.size;
    }

    /** Checks the file every `reloadMs` until `stop`. */
    start(): void {
        this.timer ??= setInterval(() => this.reload(), this.options.reloadMs ?? MEMBERS_RELOAD_MS);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Rereads the file when it changed, or always with `force`; a file it cannot use leaves the members as they were. */
    reload(force = false): void {
        let stamp: string;
        try {
            stamp = this.currentStamp();
        } catch {
            this.log({level: 'warn', event: 'members-unreadable', message: 'the members file cannot be read; keeping the members already loaded'});
            return;
        }
        if (!force && stamp === this.stamp) {
            return;
        }
        try {
            this.members = parseMembers(this.read());
            this.stamp = stamp;
            this.log({level: 'info', event: 'members-reloaded', members: this.members.size});
        } catch (error) {
            this.log({level: 'warn', event: 'members-invalid', message: `${error instanceof Error ? error.message : 'the members file is not valid'}; keeping the members already loaded`});
        }
    }

    private read(): string {
        try {
            return readFileSync(this.options.path, 'utf8');
        } catch {
            throw new MembersFileError(`the members file ${this.options.path} cannot be read`);
        }
    }

    private currentStamp(): string {
        const {mtimeMs, size} = statSync(this.options.path);
        return `${mtimeMs}:${size}`;
    }

    private log(line: Record<string, unknown>): void {
        this.options.log?.(JSON.stringify({ts: new Date().toISOString(), ...line}));
    }
}

//! Per-device room registry and credential store.
//!
//! These are two files on purpose. The registry answers "which rooms have my
//! agents joined, in which sessions" and is safe to print; credentials live
//! apart so listing a room can never disclose one.

import {chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir, platform} from 'node:os';
import {join} from 'node:path';

type RoomResolution = {room: RoomEntry} | {ambiguous: RoomEntry[]} | {missing: true};

export interface SessionEntry {
    participantId: string;
    sessionId: string;
    displayName: string;
    kind: 'agent' | 'human';
    /** The runtime that created this session, when it identified itself. A claim, never a verified fact. */
    runtime?: string;
    /**
     * The runtime's own conversation id, so a human can leave the room and go
     * instruct this agent directly. Read from the environment or passed in; the
     * relay never sees it.
     */
    conversationId?: string;
    /** Terminal session the agent is running in, to help find its pane. */
    terminal?: string;
    /** Process that invoked the CLI. */
    pid?: number;
    role: 'guest' | 'member' | 'controller';
    joinedAt: number;
    lastReadSeq: number;
    /** Where the session was working, to tell two agents in one checkout apart when listing. */
    cwd: string;
}

export interface RoomEntry {
    roomId: string;
    name: string;
    serverUrl: string;
    createdAt: number;
    /** Null for a room that does not expire. */
    expiresAt: number | null;
    /** True when this device holds the controller credential for the room. */
    controls: boolean;
    sessions: SessionEntry[];
}

/** Defaults for this device, so a human does not retype their identity on every join. */
export interface Profile {
    displayName?: string;
    kind?: 'agent' | 'human';
    runtime?: string;
    server?: string;
}

/** Behavioural preferences for this device. Distinct from the profile, which is identity. */
export interface Settings {
    /** Ask before deleting a room. */
    confirmDelete: boolean;
    /** How often the live room asks for new events, in milliseconds. */
    pollIntervalMs: number;
    /** Print participant and room ids next to names in the live room. */
    showIds: boolean;
    /** How long a new room lives, in milliseconds, or null for no expiry. */
    defaultRoomLifetimeMs: number | null;
    /** How long a new invite code stays redeemable, or null for no expiry. */
    defaultInviteLifetimeMs: number | null;
}

export const DEFAULT_SETTINGS: Settings = {confirmDelete: true, pollIntervalMs: 700, showIds: false, defaultRoomLifetimeMs: null, defaultInviteLifetimeMs: null};

export function dataDirectory(): string {
    const override = process.env['PAIRLOBBY_DATA_DIR'];
    if (override) {
        return override;
    }
    const home = homedir();
    switch (platform()) {
        case 'darwin':
            return join(home, 'Library', 'Application Support', 'PairLobby');
        case 'win32':
            return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'PairLobby');
        default:
            return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'pairlobby');
    }
}

export class LocalStore {
    readonly directory: string;

    constructor(directory = dataDirectory()) {
        this.directory = directory;
        mkdirSync(directory, {recursive: true, mode: 0o700});
    }

    private get roomsFile(): string {
        return join(this.directory, 'rooms.json');
    }

    private get credentialsFile(): string {
        return join(this.directory, 'credentials.json');
    }

    private get profileFile(): string {
        return join(this.directory, 'profile.json');
    }

    profile(): Profile {
        return readJson<Profile>(this.profileFile, {});
    }

    setProfile(profile: Profile): Profile {
        const merged = {...this.profile(), ...profile};
        for (const key of Object.keys(merged) as (keyof Profile)[]) {
            if (merged[key] === undefined) {
                delete merged[key];
            }
        }
        writeJsonPrivate(this.profileFile, merged);
        return merged;
    }

    clearProfile(): void {
        writeJsonPrivate(this.profileFile, {});
    }

    private get settingsFile(): string {
        return join(this.directory, 'settings.json');
    }

    settings(): Settings {
        return {...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(this.settingsFile, {})};
    }

    setSettings(update: Partial<Settings>): Settings {
        const merged = {...this.settings(), ...update};
        writeJsonPrivate(this.settingsFile, merged);
        return merged;
    }

    resetSettings(): Settings {
        writeJsonPrivate(this.settingsFile, {});
        return DEFAULT_SETTINGS;
    }

    rooms(): RoomEntry[] {
        return readJson<RoomEntry[]>(this.roomsFile, []);
    }

    room(roomId: string): RoomEntry | undefined {
        return this.rooms().find((entry) => entry.roomId === roomId);
    }

    /** Resolves a room by id, exact name, or unique name prefix. Ambiguity is reported, never guessed. */
    resolveRoom(reference: string): RoomResolution {
        const rooms = this.rooms();
        const exact = rooms.find((entry) => entry.roomId === reference || entry.name === reference);
        if (exact) {
            return {room: exact};
        }
        const matches = rooms.filter((entry) => entry.name.startsWith(reference) || entry.roomId.startsWith(reference));
        if (matches.length === 1) {
            return {room: matches[0]!};
        }
        if (matches.length > 1) {
            return {ambiguous: matches};
        }
        return {missing: true};
    }

    /** The only room when there is exactly one open room on this device. */
    soleRoom(now = Date.now()): RoomEntry | null {
        const open = this.rooms().filter((entry) => entry.expiresAt === null || entry.expiresAt > now);
        return open.length === 1 ? open[0]! : null;
    }

    upsertRoom(entry: RoomEntry): void {
        const rooms = this.rooms().filter((candidate) => candidate.roomId !== entry.roomId);
        rooms.push(entry);
        writeJsonPrivate(this.roomsFile, rooms);
    }

    addSession(roomId: string, session: SessionEntry): void {
        const room = this.room(roomId);
        if (!room) {
            throw new Error(`room ${roomId} is not in the local registry`);
        }
        room.sessions = room.sessions.filter((candidate) => candidate.sessionId !== session.sessionId);
        room.sessions.push(session);
        this.upsertRoom(room);
    }

    /** Attaches or corrects the runtime conversation id for a session already in the registry. */
    setConversation(roomId: string, sessionId: string, conversationId: string): boolean {
        const room = this.room(roomId);
        const session = room?.sessions.find((candidate) => candidate.sessionId === sessionId);
        if (!room || !session) {
            return false;
        }
        session.conversationId = conversationId;
        this.upsertRoom(room);
        return true;
    }

    updateCursor(roomId: string, sessionId: string, lastReadSeq: number): void {
        const room = this.room(roomId);
        const session = room?.sessions.find((candidate) => candidate.sessionId === sessionId);
        if (!room || !session) {
            return;
        }
        session.lastReadSeq = lastReadSeq;
        this.upsertRoom(room);
    }

    forgetRoom(roomId: string): void {
        writeJsonPrivate(
            this.roomsFile,
            this.rooms().filter((entry) => entry.roomId !== roomId)
        );
        const credentials = this.credentials();
        for (const key of Object.keys(credentials)) {
            if (key.startsWith(`${roomId}:`)) {
                delete credentials[key];
            }
        }
        writeJsonPrivate(this.credentialsFile, credentials);
    }

    putCredential(roomId: string, scope: string, credential: string): void {
        const credentials = this.credentials();
        credentials[`${roomId}:${scope}`] = credential;
        writeJsonPrivate(this.credentialsFile, credentials);
    }

    credential(roomId: string, scope: string): string | undefined {
        return this.credentials()[`${roomId}:${scope}`];
    }

    private credentials(): Record<string, string> {
        return readJson<Record<string, string>>(this.credentialsFile, {});
    }
}

function readJson<T>(file: string, fallback: T): T {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
        return fallback;
    }
}

/** Written through a temporary file so a crash mid-write cannot truncate the store. */
function writeJsonPrivate(file: string, value: unknown): void {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
}

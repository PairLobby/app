//! Per-device room registry and credential store.
//!
//! These are two files on purpose. The registry answers "which rooms have my
//! agents joined, in which sessions" and is safe to print; credentials live
//! apart so listing a room can never disclose one.

import {chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir, platform} from 'node:os';
import {join} from 'node:path';

import type {AutoClosePolicy, PermissionSet} from '@pairlobby/protocol';

type RoomResolution = {room: RoomEntry} | {ambiguous: RoomEntry[]} | {missing: true};

export interface SessionEntry {
    participantId: string;
    sessionId: string;
    displayName: string;
    nameSource?: 'profile' | 'room';
    kind: 'agent' | 'human';
    /** The runtime that created this session, when it identified itself. A claim, never a verified fact. */
    runtime?: string;
    /** Human session which created this managed agent locally. */
    spawnedBy?: string;
    /** Configured values; not a claim about the model actually used by the provider. */
    model?: string;
    effort?: string;
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
    /** Chosen by a human chat, never inferred from a matching display name. */
    preferredHumanSessionId?: string;
}

/**
 * A named room setup saved on this device. Configuration only: no credentials and
 * nothing that names a participant, so it can be applied to any room.
 */
export interface RoomPreset {
    name: string;
    savedAt: number;
    /** Room-wide command permissions as decided; an absent command means the built-in default. */
    permissions: PermissionSet;
    turnMode: 'sequential' | 'parallel';
    inviteRole: 'member' | 'guest';
    autoClose: AutoClosePolicy;
}

type PresetLibrary = {default: string | null; presets: RoomPreset[]};

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
    /** Check GitHub for a newer PairLobby release, at most once a day. */
    updateCheck: boolean;
    /** Install a newer release in the background instead of only offering it. */
    autoUpdate: boolean;
    /** Stop a managed request after this long without runtime output. */
    managedTaskIdleMs: number;
    /** Stop a managed request at this absolute elapsed time even when active. */
    managedTaskTimeoutMs: number;
    /** Reply mode for rooms this device creates. */
    defaultTurnMode: 'sequential' | 'parallel';
    /** What a plain `/invite` admits in rooms this device creates. */
    defaultInviteRole: 'member' | 'guest';
    /** Whether local rooms this device creates let anyone with the room id read as a guest. */
    defaultGuestAccess: 'invite_only' | 'open_to_guests';
    /** Whether online rooms this device creates are restricted to allowed accounts. */
    defaultPrivateOnline: boolean;
    /** Auto-close for rooms this device creates: off, idle:<duration>, age:<duration> or agents-and-guests-left. */
    defaultAutoClose: string;
    /** Which other devices this device's relay (`pairlobby serve`) accepts: none, Tailscale peers, or the local network. */
    relayNetwork: 'off' | 'tailscale' | 'lan';
    /** Show rooms open to the local network or tailnet in the room list, which searches the network on each refresh. */
    networkRooms: boolean;
    /** How the room list marks where a room lives: Nerd Font icons where this terminal is known to draw them and emoji elsewhere, or always one set. */
    icons: 'auto' | 'nerd' | 'emoji' | 'symbols';
}

export const DEFAULT_SETTINGS: Settings = {
    confirmDelete: true,
    pollIntervalMs: 700,
    showIds: false,
    defaultRoomLifetimeMs: null,
    defaultInviteLifetimeMs: null,
    updateCheck: true,
    autoUpdate: false,
    managedTaskIdleMs: 10 * 60_000,
    managedTaskTimeoutMs: 60 * 60_000,
    defaultTurnMode: 'sequential',
    defaultInviteRole: 'member',
    defaultGuestAccess: 'invite_only',
    defaultPrivateOnline: false,
    defaultAutoClose: 'off',
    relayNetwork: 'off',
    networkRooms: true,
    icons: 'auto',
};

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
        const previous = this.rooms();
        const rooms = previous.filter((candidate) => candidate.roomId !== entry.roomId);
        rooms.push({...previous.find((candidate) => candidate.roomId === entry.roomId), ...entry});
        writeJsonPrivate(this.roomsFile, rooms);
    }

    rememberHumanSession(roomId: string, sessionId: string): void {
        const room = this.room(roomId);
        const session = room?.sessions.find((candidate) => candidate.sessionId === sessionId);
        if (!room || session?.kind !== 'human' || !this.credential(roomId, sessionId)) {
            throw new Error('a preferred human session must have a saved human membership and credential');
        }
        this.upsertRoom({...room, preferredHumanSessionId: sessionId});
    }

    updateSessionName(roomId: string, sessionId: string, displayName: string, nameSource?: 'profile' | 'room'): void {
        const room = this.room(roomId);
        const session = room?.sessions.find((candidate) => candidate.sessionId === sessionId);
        if (!room || !session) {
            return;
        }
        session.displayName = displayName;
        if (nameSource) {
            session.nameSource = nameSource;
        }
        this.upsertRoom(room);
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

    private get presetsFile(): string {
        return join(this.directory, 'presets.json');
    }

    private presetLibrary(): PresetLibrary {
        const saved = readJson<Partial<PresetLibrary>>(this.presetsFile, {});
        return {default: saved.default ?? null, presets: saved.presets ?? []};
    }

    presets(): RoomPreset[] {
        return this.presetLibrary().presets;
    }

    /** Names match without regard to case, so "Team" and "team" are one preset. */
    preset(name: string): RoomPreset | undefined {
        return this.presets().find((preset) => preset.name.toLowerCase() === name.toLowerCase());
    }

    /** Adds the preset, or replaces the one with the same name. Returns true when it replaced one. */
    savePreset(preset: RoomPreset): boolean {
        const library = this.presetLibrary();
        const others = library.presets.filter((saved) => saved.name.toLowerCase() !== preset.name.toLowerCase());
        const replaced = others.length !== library.presets.length;
        const wasDefault = library.default?.toLowerCase() === preset.name.toLowerCase();
        writeJsonPrivate(this.presetsFile, {default: wasDefault ? preset.name : library.default, presets: [...others, preset]});
        return replaced;
    }

    /** Removes a preset, and stops using it for new rooms if it was the default. Returns false when none had that name. */
    deletePreset(name: string): boolean {
        const library = this.presetLibrary();
        const others = library.presets.filter((saved) => saved.name.toLowerCase() !== name.toLowerCase());
        if (others.length === library.presets.length) {
            return false;
        }
        writeJsonPrivate(this.presetsFile, {default: library.default?.toLowerCase() === name.toLowerCase() ? null : library.default, presets: others});
        return true;
    }

    /** The preset applied to rooms this device creates, if one is chosen and still exists. */
    defaultPreset(): RoomPreset | undefined {
        const name = this.presetLibrary().default;
        return name ? this.preset(name) : undefined;
    }

    setDefaultPreset(name: string | null): void {
        writeJsonPrivate(this.presetsFile, {...this.presetLibrary(), default: name});
    }

    putCredential(roomId: string, scope: string, credential: string): void {
        const credentials = this.credentials();
        credentials[`${roomId}:${scope}`] = credential;
        writeJsonPrivate(this.credentialsFile, credentials);
    }

    /** Admission codes are private local data, not public registry metadata. */
    putSessionInvite(roomId: string, sessionId: string, code: string): void {
        this.putCredential(roomId, `invite:${sessionId}`, code);
    }

    sessionInvite(roomId: string, sessionId: string): string | undefined {
        return this.credential(roomId, `invite:${sessionId}`);
    }

    credential(roomId: string, scope: string): string | undefined {
        return this.credentials()[`${roomId}:${scope}`];
    }

    /** Removes one credential and leaves every other scope and room alone; a missing one is not an error. */
    forgetCredential(roomId: string, scope: string): void {
        const credentials = this.credentials();
        const key = `${roomId}:${scope}`;
        if (!(key in credentials)) {
            return;
        }
        delete credentials[key];
        writeJsonPrivate(this.credentialsFile, credentials);
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

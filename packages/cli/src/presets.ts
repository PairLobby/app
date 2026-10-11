//! Named room setups saved on this device: capture one room's configuration, apply
//! it to another, or use it for every room this device creates. A preset holds
//! configuration only, never a credential or a participant.

import {ProtocolError, ROOM_PERMISSIONS, roomPermissions} from '@pairlobby/protocol';
import type {PermissionChange, RoomSnapshot} from '@pairlobby/protocol';
import type {LocalStore, PairLobbyClient, RoomPreset} from '@pairlobby/client';

import {describeAutoClose} from './auto-close.js';

export type PresetCommandContext = {
    client: PairLobbyClient;
    store: LocalStore;
    roomId: string;
    credential: string;
    controllerCredential?: string | undefined;
    participantId: string;
};

/** One setting a preset would change in a room, and how to change it. */
export type PresetChange = {label: string; from: string; to: string; apply: (authority: string) => Promise<unknown>};

type PresetTarget = {client: PairLobbyClient; roomId: string};

export const PRESET_USAGE = 'Usage: /preset [list], /preset save <name>, /preset show <name>, /preset apply <name> [confirm], /preset delete <name>, /preset default <name|none>';

const PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const RESERVED_NAMES = ['none', 'confirm', 'list'];

export function isPresetCommand(line: string): boolean {
    return /^\/presets?(?:\s|$)/.test(line);
}

export function presetName(name: string | undefined): string {
    if (!name || !PRESET_NAME.test(name) || RESERVED_NAMES.includes(name.toLowerCase())) {
        throw new Error('A preset name is 1–32 letters, digits, - or _, starting with a letter or digit. none, confirm and list are reserved.');
    }
    return name;
}

export function presetFromRoom(name: string, room: RoomSnapshot, now = Date.now()): RoomPreset {
    return {name, savedAt: now, permissions: {...room.policy.permissions}, turnMode: room.turnMode ?? 'sequential', inviteRole: room.policy.inviteRole ?? 'member', autoClose: room.policy.autoClose ?? {mode: 'off'}};
}

function describePermissions(permissions: RoomPreset['permissions']): string {
    const members = roomPermissions(permissions);
    const allowed = ROOM_PERMISSIONS.filter((permission) => members[permission]);
    return allowed.length ? `members may ${allowed.join(', ')}` : 'owner and admins only';
}

export function describePreset(preset: RoomPreset): string {
    return [
        `Preset ${preset.name} (saved ${new Date(preset.savedAt).toLocaleDateString()})`,
        `  Command permissions  ${describePermissions(preset.permissions)}`,
        `  Reply mode           ${preset.turnMode}`,
        `  Invitations          ${preset.inviteRole === 'guest' ? 'read-only observers' : 'members who can speak'}`,
        `  Auto-close           ${describeAutoClose(preset.autoClose)}`,
    ].join('\n');
}

/** Only what differs, so applying a preset to a room that already matches does nothing and says so. */
export function presetChanges(preset: RoomPreset, room: RoomSnapshot, target: PresetTarget): PresetChange[] {
    const {client, roomId} = target;
    const changes: PresetChange[] = [];
    const current = roomPermissions(room.policy.permissions);
    const wanted = roomPermissions(preset.permissions);
    if (ROOM_PERMISSIONS.some((permission) => current[permission] !== wanted[permission])) {
        // The preset replaces the room's decisions entirely: a command it leaves undecided goes back to the default.
        const change: PermissionChange = Object.fromEntries(ROOM_PERMISSIONS.map((permission) => [permission, preset.permissions[permission] ?? null]));
        changes.push({label: 'Command permissions', from: describePermissions(room.policy.permissions ?? {}), to: describePermissions(preset.permissions), apply: (authority) => client.setRoomPermissions(roomId, authority, change)});
    }
    if ((room.turnMode ?? 'sequential') !== preset.turnMode) {
        changes.push({label: 'Reply mode', from: room.turnMode ?? 'sequential', to: preset.turnMode, apply: (authority) => client.setTurnMode(roomId, authority, preset.turnMode)});
    }
    if ((room.policy.inviteRole ?? 'member') !== preset.inviteRole) {
        const words = (role: 'member' | 'guest') => role === 'guest' ? 'read-only observers' : 'members who can speak';
        changes.push({label: 'Invitations', from: words(room.policy.inviteRole ?? 'member'), to: words(preset.inviteRole), apply: (authority) => client.setInviteRole(roomId, authority, preset.inviteRole)});
    }
    const autoClose = room.policy.autoClose ?? {mode: 'off' as const};
    if (JSON.stringify(autoClose) !== JSON.stringify(preset.autoClose)) {
        changes.push({label: 'Auto-close', from: describeAutoClose(autoClose), to: describeAutoClose(preset.autoClose), apply: (authority) => client.setAutoClose(roomId, authority, preset.autoClose)});
    }
    return changes;
}

/** Applies each change on its own, so one refusal does not hide what was and was not changed. */
export async function applyPresetChanges(changes: PresetChange[], authority: string): Promise<string[]> {
    const lines: string[] = [];
    for (const change of changes) {
        try {
            await change.apply(authority);
            lines.push(`  ${change.label}: ${change.to}`);
        } catch (error) {
            lines.push(`  ${change.label}: not changed — ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return lines;
}

/** The commands that only touch this device's saved presets. Returns null for one that needs a room. */
export function runPresetLibraryCommand(words: string[], store: LocalStore): string | null {
    const [action, name, ...rest] = words;
    if (action === undefined || action === 'list') {
        if (name !== undefined) {
            throw new Error(PRESET_USAGE);
        }
        const presets = store.presets();
        if (presets.length === 0) {
            return 'No presets saved on this device. In a room, /preset save <name> saves its current setup.';
        }
        const chosen = store.defaultPreset()?.name;
        return ['Presets on this device:', ...presets.map((preset) => `  ${preset.name}${preset.name === chosen ? ' (default for new rooms)' : ''} — ${describePermissions(preset.permissions)} · ${preset.turnMode} replies`)].join('\n');
    }
    if (action === 'save' || action === 'apply') {
        return null;
    }
    if (rest.length > 0 || !['show', 'delete', 'default'].includes(action)) {
        throw new Error(PRESET_USAGE);
    }
    if (action === 'default' && name?.toLowerCase() === 'none') {
        store.setDefaultPreset(null);
        return 'New rooms use the built-in defaults and your device settings again.';
    }
    const preset = store.preset(presetName(name));
    if (!preset) {
        throw new Error(`No preset named ${name}. /preset lists them.`);
    }
    if (action === 'show') {
        return describePreset(preset);
    }
    if (action === 'delete') {
        store.deletePreset(preset.name);
        return `Preset ${preset.name} deleted. Rooms it was applied to keep their settings.`;
    }
    store.setDefaultPreset(preset.name);
    return `Rooms this device creates now start with preset ${preset.name}. Existing rooms are not changed.`;
}

export async function runPresetCommand(argument: string, context: PresetCommandContext): Promise<string> {
    const words = argument.split(/\s+/).filter(Boolean);
    const local = runPresetLibraryCommand(words, context.store);
    if (local !== null) {
        return local;
    }
    const {client, store, roomId, credential, controllerCredential, participantId} = context;
    const [action, rawName, confirmation, ...rest] = words;
    if (rest.length > 0 || (confirmation !== undefined && (action !== 'apply' || confirmation !== 'confirm'))) {
        throw new Error(PRESET_USAGE);
    }
    const name = presetName(rawName);
    const room = await client.snapshot(roomId, credential);
    if (action === 'save') {
        const replaced = store.savePreset(presetFromRoom(name, room));
        return `${replaced ? 'Updated' : 'Saved'} preset ${name} from this room.\n${describePreset(store.preset(name)!)}`;
    }
    const preset = store.preset(name);
    if (!preset) {
        throw new Error(`No preset named ${name}. /preset lists them.`);
    }
    const changes = presetChanges(preset, room, {client, roomId});
    if (changes.length === 0) {
        return `This room already matches preset ${preset.name}.`;
    }
    const proposed = changes.map((change) => `  ${change.label}: ${change.from} → ${change.to}`);
    if (confirmation !== 'confirm') {
        return [`Preset ${preset.name} would change this room:`, ...proposed, `Run /preset apply ${preset.name} confirm to apply. Members' own permissions are not touched.`].join('\n');
    }
    const self = room.participants.find((participant) => participant.participantId === participantId);
    const authority = controllerCredential ?? (self?.role === 'controller' ? credential : undefined);
    if (!authority) {
        throw new ProtocolError('unauthorized', 'only the room owner and admins apply a preset');
    }
    return [`Applied preset ${preset.name}:`, ...(await applyPresetChanges(changes, authority))].join('\n');
}

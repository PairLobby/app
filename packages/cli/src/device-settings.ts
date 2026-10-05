//! This device's preferences: one definition per setting, shared by
//! `pairlobby settings <name> <value>` and the interactive `pairlobby settings` menu.

import type {LocalStore, Profile, Settings} from '@pairlobby/client';

import {UsageError} from './context.js';
import type {PanelChoice, RoomPanelPage, RoomPanelRow} from './room-panel.js';
import {AUTO_CLOSE_CHOICES, AUTO_CLOSE_USAGE, applyAutoCloseToRooms, describeAutoClose, formatAutoClose, parseAutoClose, summarizeBulk} from './auto-close.js';
import {WhenError, formatDuration, parseDuration} from './when.js';

type SettingKind = 'boolean' | 'number' | 'duration' | 'choice' | 'auto-close';

export type SettingDefinition = {
    field: keyof Settings;
    kind: SettingKind;
    label: string;
    section: string;
    help: string;
    choices?: PanelChoice[];
};

const ON_OFF: PanelChoice[] = [{label: 'On', value: 'true'}, {label: 'Off', value: 'false'}];

export const SETTING_KEYS: Record<string, SettingDefinition> = {
    'default-reply-mode': {field: 'defaultTurnMode', kind: 'choice', label: 'Reply mode', section: 'New rooms', help: 'how agents answer in rooms you create: sequential or parallel', choices: [{label: 'Sequential — one agent answers at a time', value: 'sequential'}, {label: 'Parallel — different agents can work together', value: 'parallel'}]},
    'default-invites': {field: 'defaultInviteRole', kind: 'choice', label: 'Invitations', section: 'New rooms', help: 'what a plain /invite admits in rooms you create: member or observer', choices: [{label: 'Members — invitees can send messages', value: 'member'}, {label: 'Read-only observers — invitees can only read', value: 'guest'}]},
    'default-guest-access': {field: 'defaultGuestAccess', kind: 'choice', label: 'Guest access (local rooms)', section: 'New rooms', help: 'whether anyone with a local room id may read it: invite-only or open', choices: [{label: 'Invite only — require an invitation', value: 'invite_only'}, {label: 'Anyone with the room ID may read as a guest', value: 'open_to_guests'}]},
    'default-private-online': {field: 'defaultPrivateOnline', kind: 'boolean', label: 'Private online rooms', section: 'New rooms', help: 'restrict online rooms you create to allowed accounts (create online --public overrides)'},
    'auto-close': {field: 'defaultAutoClose', kind: 'auto-close', label: 'Auto-close discussions', section: 'New rooms', help: `when rooms you create close themselves: ${AUTO_CLOSE_USAGE}`, choices: AUTO_CLOSE_CHOICES},
    'default-expiry': {field: 'defaultRoomLifetimeMs', kind: 'duration', label: 'Room expiry', section: 'New rooms', help: 'how long a new room lives: never, or a duration like 24h'},
    'default-invite-expiry': {field: 'defaultInviteLifetimeMs', kind: 'duration', label: 'Invite expiry', section: 'New rooms', help: 'how long a new invite code lasts: never, or a duration like 10m'},
    'confirm-delete': {field: 'confirmDelete', kind: 'boolean', label: 'Confirm deletes', section: 'Terminal', help: 'ask before deleting a room'},
    'show-ids': {field: 'showIds', kind: 'boolean', label: 'Show IDs', section: 'Terminal', help: 'print ids next to names in the live room'},
    'poll-interval': {field: 'pollIntervalMs', kind: 'number', label: 'Poll interval (ms)', section: 'Terminal', help: 'milliseconds between live-room polls'},
    'update-check': {field: 'updateCheck', kind: 'boolean', label: 'Check for updates', section: 'Updates', help: 'check GitHub for a new PairLobby release once a day'},
    'auto-update': {field: 'autoUpdate', kind: 'boolean', label: 'Install updates automatically', section: 'Updates', help: 'install new releases in the background (needs update-check)'},
    'network-sharing': {field: 'relayNetwork', kind: 'choice', label: 'Share this device\'s relay', section: 'Network', help: 'which other devices may join rooms on this device\'s relay: off, tailscale or lan; restart the relay to apply', choices: [{label: 'Off — only this device', value: 'off'}, {label: 'Tailscale — your devices on your tailnet, encrypted', value: 'tailscale'}, {label: 'Local network — any device on this Wi-Fi or LAN, unencrypted', value: 'lan'}]},
    'network-rooms': {field: 'networkRooms', kind: 'boolean', label: 'Show rooms on my network', section: 'Network', help: 'list rooms open to the local network or tailnet beside your own; searches the network when the room list refreshes'},
};

/** Printed after network-sharing changes: a running relay keeps the setting it started with. */
export const NETWORK_SHARING_RESTART = 'restart the relay to apply this: stop and rerun pairlobby serve, or run npm run service -- restart for the background relay';

export function parseBoolean(key: string, value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(normalized)) {
        return true;
    }
    if (['false', 'no', 'off', '0'].includes(normalized)) {
        return false;
    }
    throw new UsageError(`${key} takes true or false, not "${value}"`);
}

export function parseLifetime(value: string): number | null {
    const normalized = value.trim().toLowerCase();
    if (['never', 'none', 'off', 'no', 'permanent', 'forever'].includes(normalized)) {
        return null;
    }
    try {
        return parseDuration(normalized);
    } catch (error) {
        throw new UsageError(error instanceof WhenError ? error.message : String(error));
    }
}

export function describeLifetime(ms: number | null): string {
    return ms === null ? 'never' : formatDuration(ms);
}

export function parseCount(key: string, value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new UsageError(`${key} takes a positive number, not "${value}"`);
    }
    return parsed;
}

/** Choice values accept their short names too: observer for guest, open for open_to_guests. */
const CHOICE_ALIASES: Record<string, string> = {observer: 'guest', 'read-only': 'guest', open: 'open_to_guests', 'invite-only': 'invite_only'};

export function parseSettingValue(key: string, definition: SettingDefinition, value: string): Settings[keyof Settings] {
    switch (definition.kind) {
        case 'boolean':  return parseBoolean(key, value);
        case 'duration': return parseLifetime(value);
        case 'number':   return parseCount(key, value);
        case 'auto-close': return formatAutoClose(parseAutoClose(value));
        case 'choice': {
            const normalized = value.trim().toLowerCase();
            const chosen = CHOICE_ALIASES[normalized] ?? normalized;
            if (!definition.choices!.some((choice) => choice.value === chosen)) {
                throw new UsageError(`${key} takes ${definition.choices!.map((choice) => choice.value).join(' or ')}, not "${value}"`);
            }
            return chosen as Settings[keyof Settings];
        }
    }
}

export function describeSettingValue(definition: SettingDefinition, value: Settings[keyof Settings]): string {
    if (definition.kind === 'duration') {
        return describeLifetime(value as number | null);
    }
    if (definition.kind === 'choice') {
        return definition.choices!.find((choice) => choice.value === value)?.label.split(' — ')[0] ?? String(value);
    }
    if (definition.kind === 'boolean') {
        return value ? 'On' : 'Off';
    }
    if (definition.kind === 'auto-close') {
        return describeAutoClose(parseAutoClose(String(value)));
    }
    return String(value);
}

type MenuState = {note: string};

/** The interactive menu: every setting grouped by section, each saved as soon as it is applied. */
export function deviceSettingsPage(store: LocalStore, state: MenuState = {note: ''}): RoomPanelPage {
    const settings = store.settings();
    const profile = store.profile();
    const rows: RoomPanelRow[] = [
        {id: 'profile-name', label: 'Default name', value: profile.displayName ?? 'Not set — your account name is used', section: 'Profile', action: {kind: 'edit', initial: profile.displayName ?? '', hint: 'The name you join rooms with when you pass no --as. 1–64 characters; blank clears it.', save: async (value) => {
            const name = value.trim();
            if (name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) {
                throw new Error('Use a name of 1–64 characters without control characters.');
            }
            // setProfile merges and drops undefined fields, so a blank name clears it.
            store.setProfile({displayName: name || undefined} as Profile);
        }}},
    ];
    for (const [key, definition] of Object.entries(SETTING_KEYS)) {
        const current = settings[definition.field];
        const choices = definition.kind === 'boolean' ? ON_OFF : definition.choices;
        const initial = definition.kind === 'duration' ? describeLifetime(current as number | null) : String(current);
        rows.push({id: key, label: definition.label, value: describeSettingValue(definition, current), section: definition.section, action: {kind: 'edit', initial, ...(choices ? {choices} : {}), hint: `${definition.help} · shell: pairlobby settings ${key} <value>`, save: async (value) => {
            store.setSettings({[definition.field]: parseSettingValue(key, definition, value)} as Partial<Settings>);
        }}});
    }
    const autoClose = parseAutoClose(settings.defaultAutoClose);
    rows.push({id: 'apply-auto-close', label: 'Apply auto-close to my rooms', value: state.note || 'Existing rooms you administer on this device', section: 'New rooms', action: {kind: 'command', confirm: `Set auto-close to "${describeAutoClose(autoClose).toLowerCase()}" on every room this device administers? Rooms already past that limit close immediately. Rooms it cannot reach or change are listed, not changed.`, run: async () => {
        state.note = summarizeBulk(await applyAutoCloseToRooms(store, autoClose));
    }}});
    rows.push({id: 'reset', label: 'Reset all settings', value: 'Back to the built-in defaults', section: 'Reset', action: {kind: 'command', confirm: 'Reset every device setting to its default? Your profile name is kept.', run: async () => {
        store.resetSettings();
    }}});
    return {id: 'device-settings', title: 'PairLobby settings — this device', rows, note: 'Enter edits a setting and saves it immediately. Room-specific settings live in /settings inside a room.', reload: async () => deviceSettingsPage(store, state)};
}

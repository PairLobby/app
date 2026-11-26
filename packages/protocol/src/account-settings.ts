//! Preferences an account keeps for its devices. Each setting syncs on its own and
//! the most recent change wins, so edits to different settings on two devices both survive.

import {z} from 'zod';

const MAX_LIFETIME_MS = 10 * 365 * 24 * 3600_000;
const MIN_MANAGED_MS = 1000;
const MAX_MANAGED_MS = 24 * 3600_000;
const MIN_AUTO_CLOSE_MS = 60_000;

const AUTO_CLOSE_UNITS: Record<string, number> = {s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000};

/** The canonical auto-close forms the CLI writes: off, idle:2h, age:7d or agents-and-guests-left. */
export function validAutoCloseSetting(value: string): boolean {
    if (value === 'off' || value === 'agents-and-guests-left') {
        return true;
    }
    const match = /^(idle|age):([1-9]\d{0,9})([smhd])$/.exec(value);
    if (!match) {
        return false;
    }
    const ms = Number(match[2]) * AUTO_CLOSE_UNITS[match[3]!]!;
    return ms >= MIN_AUTO_CLOSE_MS && ms <= MAX_LIFETIME_MS;
}

const lifetime = z.number().positive().max(MAX_LIFETIME_MS).nullable();
const managed = z.number().int().min(MIN_MANAGED_MS).max(MAX_MANAGED_MS);

/** One schema per synced setting. The values are the ones the CLI stores in its settings file. */
export const ACCOUNT_SETTING_SCHEMAS = {
    displayName: z.string().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/).refine((name) => name.trim() === name, 'no surrounding spaces').nullable(),
    defaultTurnMode: z.enum(['sequential', 'parallel']),
    defaultInviteRole: z.enum(['member', 'guest']),
    defaultGuestAccess: z.enum(['invite_only', 'open_to_guests']),
    defaultPrivateOnline: z.boolean(),
    defaultAutoClose: z.string().max(32).refine(validAutoCloseSetting, 'use off, idle:<duration>, age:<duration> or agents-and-guests-left, at least one minute'),
    defaultRoomLifetimeMs: lifetime,
    defaultInviteLifetimeMs: lifetime,
    confirmDelete: z.boolean(),
    leaveOccupiedRooms: z.boolean(),
    deleteEmptyRooms: z.boolean(),
    showIds: z.boolean(),
    managedTaskIdleMs: managed,
    managedTaskTimeoutMs: managed,
} as const;

export type AccountSettingField = keyof typeof ACCOUNT_SETTING_SCHEMAS;
export type AccountSettingValues = {[F in AccountSettingField]: z.infer<typeof ACCOUNT_SETTING_SCHEMAS[F]>};

export const ACCOUNT_SETTING_FIELDS = Object.keys(ACCOUNT_SETTING_SCHEMAS) as AccountSettingField[];

/** The managed task limits always travel together, so newest-wins can never pair an inactivity limit with a shorter absolute one. */
export const LINKED_ACCOUNT_SETTINGS: AccountSettingField[][] = [['managedTaskIdleMs', 'managedTaskTimeoutMs']];

/** What a device starts from before anything is synced. Matches the CLI's own defaults. */
export const ACCOUNT_SETTING_DEFAULTS: AccountSettingValues = {
    displayName: null,
    defaultTurnMode: 'sequential',
    defaultInviteRole: 'member',
    defaultGuestAccess: 'invite_only',
    defaultPrivateOnline: false,
    defaultAutoClose: 'off',
    defaultRoomLifetimeMs: null,
    defaultInviteLifetimeMs: null,
    confirmDelete: true,
    leaveOccupiedRooms: true,
    deleteEmptyRooms: true,
    showIds: false,
    managedTaskIdleMs: 10 * 60_000,
    managedTaskTimeoutMs: 60 * 60_000,
};

export function isAccountSettingField(field: string): field is AccountSettingField {
    return Object.hasOwn(ACCOUNT_SETTING_SCHEMAS, field);
}

/** Every field that must be sent with this one, itself included. */
export function linkedAccountSettings(field: AccountSettingField): AccountSettingField[] {
    return LINKED_ACCOUNT_SETTINGS.find((group) => group.includes(field)) ?? [field];
}

export const AccountSettingEntry = z.object({value: z.unknown(), updatedAt: z.number().int().nonnegative()});
export type AccountSettingEntry = {value: unknown; updatedAt: number};

export const AccountSettingChange = z.object({field: z.string(), value: z.unknown(), updatedAt: z.number().int().nonnegative()});
export type AccountSettingChange = {field: AccountSettingField; value: unknown; updatedAt: number};

export type AccountSettingsMap = Partial<Record<AccountSettingField, AccountSettingEntry>>;

/** What the service answers: every setting the account has, with when it last changed, and the service's clock. */
export type AccountSettingsDocument = {settings: AccountSettingsMap; serverTime: number};

export class AccountSettingsError extends Error {}

/** Checks a batch of changes as a whole: known fields, valid values, no repeats, linked settings together and consistent. */
export function parseAccountSettingChanges(input: unknown): AccountSettingChange[] {
    const parsed = z.object({changes: z.array(AccountSettingChange).min(1).max(ACCOUNT_SETTING_FIELDS.length)}).safeParse(input);
    if (!parsed.success) {
        throw new AccountSettingsError('Send changes as {changes: [{field, value, updatedAt}]}');
    }
    const byField = new Map<AccountSettingField, AccountSettingChange>();
    for (const change of parsed.data.changes) {
        if (!isAccountSettingField(change.field)) {
            throw new AccountSettingsError(`${change.field} is not a synced setting`);
        }
        if (byField.has(change.field)) {
            throw new AccountSettingsError(`${change.field} appears twice`);
        }
        const value = ACCOUNT_SETTING_SCHEMAS[change.field].safeParse(change.value);
        if (!value.success) {
            throw new AccountSettingsError(`${change.field}: ${value.error.issues[0]?.message ?? 'invalid value'}`);
        }
        byField.set(change.field, {field: change.field, value: value.data, updatedAt: change.updatedAt});
    }
    for (const group of LINKED_ACCOUNT_SETTINGS) {
        const present = group.filter((field) => byField.has(field));
        if (present.length === 0) {
            continue;
        }
        if (present.length !== group.length || new Set(present.map((field) => byField.get(field)!.updatedAt)).size !== 1) {
            throw new AccountSettingsError(`${group.join(' and ')} change together, with one time`);
        }
    }
    const idle = byField.get('managedTaskIdleMs');
    const timeout = byField.get('managedTaskTimeoutMs');
    if (idle && timeout && (timeout.value as number) < (idle.value as number)) {
        throw new AccountSettingsError('managedTaskTimeoutMs must be at least managedTaskIdleMs');
    }
    return [...byField.values()];
}

/** Keeps the settings this version knows and can read; a newer service may send more. */
export function parseAccountSettingsDocument(input: unknown): AccountSettingsDocument {
    const parsed = z.object({settings: z.record(z.string(), z.unknown()), serverTime: z.number().int().nonnegative()}).safeParse(input);
    if (!parsed.success) {
        throw new AccountSettingsError('The service sent settings this version cannot read');
    }
    const settings: AccountSettingsMap = {};
    for (const [field, raw] of Object.entries(parsed.data.settings)) {
        const entry = AccountSettingEntry.safeParse(raw);
        if (!isAccountSettingField(field) || !entry.success || !ACCOUNT_SETTING_SCHEMAS[field].safeParse(entry.data.value).success) {
            continue;
        }
        settings[field] = {value: entry.data.value, updatedAt: entry.data.updatedAt};
    }
    return {settings, serverTime: parsed.data.serverTime};
}

export type AccountSettingKind = 'boolean' | 'choice' | 'name' | 'lifetime' | 'managed-duration' | 'auto-close';
export type AccountSettingChoice = {label: string; value: string};
export type AccountSettingDefinition = {field: AccountSettingField; key: string; kind: AccountSettingKind; section: string; label: string; help: string; choices?: AccountSettingChoice[]};

/** How the website shows each setting. `key` is the name `pairlobby settings <key>` takes. */
export const ACCOUNT_SETTING_DEFINITIONS: AccountSettingDefinition[] = [
    {field: 'displayName', key: 'profile-name', kind: 'name', section: 'Profile', label: 'Default name', help: 'The name you join rooms with when you pass no --as. Empty uses your account name.'},
    {field: 'defaultTurnMode', key: 'default-reply-mode', kind: 'choice', section: 'New rooms', label: 'Reply mode', help: 'How agents answer in rooms you create.', choices: [{label: 'Sequential: one agent answers at a time', value: 'sequential'}, {label: 'Parallel: different agents can work together', value: 'parallel'}]},
    {field: 'defaultInviteRole', key: 'default-invites', kind: 'choice', section: 'New rooms', label: 'Invitations', help: 'What a plain /invite admits in rooms you create.', choices: [{label: 'Members, who can send messages', value: 'member'}, {label: 'Read-only visitors', value: 'guest'}]},
    {field: 'defaultGuestAccess', key: 'default-guest-access', kind: 'choice', section: 'New rooms', label: 'Visitor access (local rooms)', help: 'Whether anyone with a local room id may read it.', choices: [{label: 'Invite only', value: 'invite_only'}, {label: 'Anyone with the room ID may read', value: 'open_to_guests'}]},
    {field: 'defaultPrivateOnline', key: 'default-private-online', kind: 'boolean', section: 'New rooms', label: 'Private online rooms', help: 'Restrict online rooms you create to allowed accounts.'},
    {field: 'defaultAutoClose', key: 'auto-close', kind: 'auto-close', section: 'New rooms', label: 'Auto-close discussions', help: 'When rooms you create close themselves.', choices: [{label: 'Off', value: 'off'}, {label: 'After 1 hour without messages', value: 'idle:1h'}, {label: 'After 24 hours without messages', value: 'idle:24h'}, {label: 'After 7 days without messages', value: 'idle:7d'}, {label: '24 hours after creation', value: 'age:24h'}, {label: '7 days after creation', value: 'age:7d'}, {label: 'When all agents and visitors have left', value: 'agents-and-guests-left'}]},
    {field: 'defaultRoomLifetimeMs', key: 'default-expiry', kind: 'lifetime', section: 'New rooms', label: 'Room expiry', help: 'How long a new room lives.'},
    {field: 'defaultInviteLifetimeMs', key: 'default-invite-expiry', kind: 'lifetime', section: 'New rooms', label: 'Invite expiry', help: 'How long a new invite code lasts.'},
    {field: 'confirmDelete', key: 'confirm-delete', kind: 'boolean', section: 'Terminal', label: 'Confirm deletes', help: 'Ask before deleting a room, or removing one from a device.'},
    {field: 'leaveOccupiedRooms', key: 'leave-occupied-rooms', kind: 'boolean', section: 'Terminal', label: 'Leave rooms others are in', help: 'Deleting a room you own while anyone else is in it only removes it from your rooms.'},
    {field: 'deleteEmptyRooms', key: 'delete-empty-rooms', kind: 'boolean', section: 'Terminal', label: 'Delete rooms left empty', help: 'Deleting a room you own when no one else is in it deletes it for everyone, with its history.'},
    {field: 'showIds', key: 'show-ids', kind: 'boolean', section: 'Terminal', label: 'Show IDs', help: 'Print ids next to names in the live room.'},
    {field: 'managedTaskIdleMs', key: 'managed-task-idle-timeout', kind: 'managed-duration', section: 'Agents', label: 'Managed task inactivity limit', help: 'Stop a managed agent request after no output for this long (1 second to 24 hours).'},
    {field: 'managedTaskTimeoutMs', key: 'managed-task-timeout', kind: 'managed-duration', section: 'Agents', label: 'Managed task absolute limit', help: 'Stop a managed agent request after this total time, even while active. At least the inactivity limit.'},
];

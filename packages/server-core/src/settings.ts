import {ABSOLUTE_MAX_FILE_BYTES, RECEIPT_MODES} from '@pairlobby/protocol';
import type {ReceiptMode, RoomPolicy} from '@pairlobby/protocol';
import type {AdmissionLimits} from './admission.js';

/** A setting the relay cannot start with; the message names the flag or variable that holds it. */
export class RelaySettingsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RelaySettingsError';
    }
}

/** The per-room caps a relay operator may set. */
export type RoomLimits = Pick<RoomPolicy, 'maxParticipants' | 'maxRetainedEvents' | 'maxRetainedEventBytes' | 'maxEventPayloadBytes' | 'maxFileBytes' | 'maxRetainedFileBytes'>;

type RoomLimitVariable = {key: keyof RoomLimits; variable: string; minimum: number; maximum: number; unitBytes: number};

const KIB = 1024;
const MIB = 1024 * KIB;

/** Sizes are whole KiB or MiB so a typo cannot turn into a byte count. */
export const ROOM_LIMIT_VARIABLES: RoomLimitVariable[] = [
    {key: 'maxParticipants', variable: 'PAIRLOBBY_ROOM_MAX_PARTICIPANTS', minimum: 2, maximum: 1000, unitBytes: 1},
    {key: 'maxRetainedEvents', variable: 'PAIRLOBBY_ROOM_MAX_EVENTS', minimum: 100, maximum: 10_000_000, unitBytes: 1},
    {key: 'maxRetainedEventBytes', variable: 'PAIRLOBBY_ROOM_MAX_HISTORY_MB', minimum: 1, maximum: 10_240, unitBytes: MIB},
    {key: 'maxEventPayloadBytes', variable: 'PAIRLOBBY_ROOM_MAX_MESSAGE_KB', minimum: 1, maximum: 4096, unitBytes: KIB},
    {key: 'maxFileBytes', variable: 'PAIRLOBBY_ROOM_MAX_FILE_MB', minimum: 0, maximum: ABSOLUTE_MAX_FILE_BYTES / MIB, unitBytes: MIB},
    {key: 'maxRetainedFileBytes', variable: 'PAIRLOBBY_ROOM_MAX_FILES_MB', minimum: 0, maximum: 102_400, unitBytes: MIB}
];

export const LIMIT_VARIABLES: Record<keyof AdmissionLimits, string> = {
    createPerMinutePerAddress: 'PAIRLOBBY_LIMIT_CREATE_PER_MIN_IP',
    redeemPerMinutePerAddress: 'PAIRLOBBY_LIMIT_REDEEM_PER_MIN_IP',
    redeemPerMinuteGlobal: 'PAIRLOBBY_LIMIT_REDEEM_PER_MIN_GLOBAL',
    accountCheckPerMinutePerAddress: 'PAIRLOBBY_LIMIT_ACCOUNT_CHECK_PER_MIN_IP',
    directoryPerMinutePerMember: 'PAIRLOBBY_LIMIT_DIRECTORY_PER_MIN_MEMBER',
    contactPerMinutePerMember: 'PAIRLOBBY_LIMIT_CONTACT_PER_MIN_MEMBER',
    contactPerHourPerListing: 'PAIRLOBBY_LIMIT_CONTACT_PER_HOUR_LISTING'
};

export type RelayPolicyEnvironment = Readonly<Record<string, unknown>>;
export type RelayPolicySettings = {limits: Partial<AdmissionLimits>; roomLimits: Partial<RoomLimits>; receiptMode?: ReceiptMode};
export type SettingSource = {flag?: string; variable: string};

export function wholeSettingNumber(value: string, source: SettingSource, minimum: number, maximum: number): number {
    const parsed = Number(value);
    const label = source.flag ? `--${source.flag} (${source.variable})` : source.variable;
    if (!/^\d+$/.test(value) || parsed < minimum || parsed > maximum) {
        throw new RelaySettingsError(`${label} must be a whole number from ${minimum} to ${maximum}, not "${value}"`);
    }
    return parsed;
}

/** Runtime-independent policy and admission settings, used by Node, containers and the standalone Worker. */
export function relayPolicySettings(environment: RelayPolicyEnvironment): RelayPolicySettings {
    const setting = (name: string): string | undefined => {
        const value = environment[name];
        if (value !== undefined && typeof value !== 'string') {
            throw new RelaySettingsError(`${name} must be a string`);
        }
        return value?.trim() || undefined;
    };
    const limits: Partial<AdmissionLimits> = {};
    for (const [key, variable] of Object.entries(LIMIT_VARIABLES) as [keyof AdmissionLimits, string][]) {
        const value = setting(variable);
        if (value) {
            limits[key] = wholeSettingNumber(value, {variable}, 1, 1_000_000);
        }
    }
    const roomLimits: Partial<RoomLimits> = {};
    for (const {key, variable, minimum, maximum, unitBytes} of ROOM_LIMIT_VARIABLES) {
        const value = setting(variable);
        if (value) {
            roomLimits[key] = wholeSettingNumber(value, {variable}, minimum, maximum) * unitBytes;
        }
    }
    const receiptMode = setting('PAIRLOBBY_RECEIPT_MODE');
    if (receiptMode !== undefined && !(RECEIPT_MODES as readonly string[]).includes(receiptMode)) {
        throw new RelaySettingsError(`PAIRLOBBY_RECEIPT_MODE must be events, both or watermark, not "${receiptMode}"`);
    }
    return {limits, roomLimits, ...(receiptMode ? {receiptMode: receiptMode as ReceiptMode} : {})};
}

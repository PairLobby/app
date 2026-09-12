//! Identifier generation and the human-typed invite code alphabet.

import {z} from 'zod';

/** Crockford base32: digits and uppercase letters without I, L, O, or U. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ID_BODY_LENGTH = 26;
const INVITE_CODE_LENGTH = 8;

export const ID_PREFIXES = {room: 'rm', participant: 'pt', event: 'ev', handover: 'ho', session: 'se', invite: 'iv', attempt: 'at'} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function randomAlphabet(length: number): string {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    // 256 is a multiple of 32, so masking the low 5 bits stays uniform.
    return Array.from(bytes, (byte) => CODE_ALPHABET[byte & 0x1f]).join('');
}

export function newId(kind: IdKind): string {
    return `${ID_PREFIXES[kind]}_${randomAlphabet(ID_BODY_LENGTH)}`;
}

function idSchema(kind: IdKind) {
    return z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_[${CODE_ALPHABET}]{${ID_BODY_LENGTH}}$`), `expected a ${kind} id`);
}

export const RoomId = idSchema('room');
export const ParticipantId = idSchema('participant');
export const EventId = idSchema('event');
export const HandoverId = idSchema('handover');
export const SessionId = idSchema('session');
export const AttemptId = idSchema('attempt');

/** Generates a fresh invite code in canonical `XXXX-XXXX` form. */
export function newInviteCode(): string {
    return formatInviteCode(randomAlphabet(INVITE_CODE_LENGTH));
}

/** Strips formatting and folds the characters Crockford treats as equivalent. Returns null when the result is not a well-formed code. */
export function normalizeInviteCode(input: string): string | null {
    const folded = input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
    if (folded.length !== INVITE_CODE_LENGTH) return null;
    return [...folded].every((char) => CODE_ALPHABET.includes(char)) ? folded : null;
}

export function formatInviteCode(normalized: string): string {
    return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

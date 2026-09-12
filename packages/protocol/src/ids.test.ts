import {describe, expect, test} from 'vitest';

import {CODE_ALPHABET, formatInviteCode, newId, newInviteCode, normalizeInviteCode} from './ids.js';
import {digestsEqual, hashCredential, newCredential} from './credentials.js';

describe('invite codes', () => {
    test('test_new_invite_code_is_canonical', () => {
        const code = newInviteCode();
        expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        expect(normalizeInviteCode(code)).toHaveLength(8);
    });

    test('test_normalize_folds_ambiguous_characters', () => {
        expect(normalizeInviteCode('oiln-uabc')).toBe('011N' + 'VABC');
        expect(normalizeInviteCode('k7mp4qwx')).toBe('K7MP4QWX');
        expect(normalizeInviteCode('  k7mp-4qwx  ')).toBe('K7MP4QWX');
    });

    test('test_normalize_rejects_wrong_length', () => {
        expect(normalizeInviteCode('K7MP4QW')).toBeNull();
        expect(normalizeInviteCode('K7MP4QWXY')).toBeNull();
    });

    test('test_alphabet_excludes_ambiguous_letters', () => {
        for (const letter of ['I', 'L', 'O', 'U']) expect(CODE_ALPHABET).not.toContain(letter);
    });

    test('test_format_groups_into_two_blocks', () => {
        expect(formatInviteCode('K7MP4QWX')).toBe('K7MP-4QWX');
    });
});

describe('ids', () => {
    test('test_ids_carry_their_kind_prefix', () => {
        expect(newId('room')).toMatch(/^rm_[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(newId('participant')).toMatch(/^pt_/);
        expect(newId('handover')).toMatch(/^ho_/);
    });

    test('test_ids_are_distinct', () => {
        const ids = new Set(Array.from({length: 500}, () => newId('event')));
        expect(ids.size).toBe(500);
    });
});

describe('credentials', () => {
    test('test_hash_is_stable_and_hex', async () => {
        const credential = newCredential('participant');
        const first = await hashCredential(credential);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(await hashCredential(credential)).toBe(first);
    });

    test('test_distinct_credentials_hash_differently', async () => {
        const a = await hashCredential(newCredential('participant'));
        const b = await hashCredential(newCredential('participant'));
        expect(digestsEqual(a, b)).toBe(false);
        expect(digestsEqual(a, a)).toBe(true);
    });
});

import {describe, expect, test} from 'vitest';

import {WhenError, formatDuration, parseDuration, parseExpiry} from './when.js';

const NOW = new Date(2026, 8, 13, 12, 0, 0).getTime();

describe('durations', () => {
    test('test_units_are_read_in_long_and_short_form', () => {
        expect(parseDuration('10 hours')).toBe(36_000_000);
        expect(parseDuration('10h')).toBe(36_000_000);
        expect(parseDuration('90m')).toBe(5_400_000);
        expect(parseDuration('2 days')).toBe(172_800_000);
        expect(parseDuration('1 week')).toBe(604_800_000);
    });

    test('test_a_leading_in_is_accepted', () => {
        expect(parseDuration('in 3 hours')).toBe(10_800_000);
    });

    test('test_nonsense_is_refused_rather_than_guessed_at', () => {
        expect(() => parseDuration('soon')).toThrow(WhenError);
        expect(() => parseDuration('10 fortnights')).toThrow(WhenError);
        expect(() => parseDuration('0 hours')).toThrow(WhenError);
    });

    test('test_formatting_round_trips_whole_units', () => {
        expect(formatDuration(36_000_000)).toBe('10 hours');
        expect(formatDuration(3_600_000)).toBe('1 hour');
        expect(formatDuration(604_800_000)).toBe('1 week');
    });
});

describe('expiry specs', () => {
    test('test_never_means_no_expiry', () => {
        for (const word of ['never', 'none', 'off', 'forever', 'NEVER']) expect(parseExpiry(word, NOW)).toBeNull();
    });

    test('test_relative_specs_are_measured_from_now', () => {
        expect(parseExpiry('in 10 hours', NOW)).toBe(NOW + 36_000_000);
        expect(parseExpiry('10h', NOW)).toBe(NOW + 36_000_000);
    });

    test('test_absolute_specs_are_read_in_local_time', () => {
        // A bare date means the start of that day where the reader is, not a time
        // shifted by their offset from UTC.
        expect(parseExpiry('2026-09-20', NOW)).toBe(new Date(2026, 8, 20).getTime());
        expect(parseExpiry('at 2026-09-20 18:00', NOW)).toBe(new Date(2026, 8, 20, 18, 0).getTime());
        expect(parseExpiry('2026-09-20T18:30', NOW)).toBe(new Date(2026, 8, 20, 18, 30).getTime());
    });

    test('test_an_unreadable_spec_is_refused', () => {
        expect(() => parseExpiry('whenever', NOW)).toThrow(WhenError);
        expect(() => parseExpiry('', NOW)).toThrow(WhenError);
    });
});

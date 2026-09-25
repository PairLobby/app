import {describe, expect, test} from 'vitest';

import {applyMention, commonPrefix, currentMention, matchNames, renderSuggestions, routeChatMessage} from './mentions.js';

const NAMES = ['claude', 'codex', 'hugo', 'cursor'];
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';

const PARTICIPANTS = NAMES.map((displayName) => ({participantId: `pt_${displayName}`, displayName, revoked: false, left: false}));

describe('routing complete chat messages', () => {
    test('routes the screenshot message to Codex without changing its text', () => {
        const text = 'Hey @codex, tell claude to say hi in the chat';
        expect(routeChatMessage(text, PARTICIPANTS)).toEqual({text, recipientId: 'pt_codex'});
    });

    test('handles leading, repeated, mixed-case and sentence-ending mentions', () => {
        for (const text of ['@codex hello', 'Hello @CODEX!', 'Hello @codex.', '@codex please reply, @codex']) {
            expect(routeChatMessage(text, PARTICIPANTS).recipientId).toBe('pt_codex');
        }
    });

    test('email addresses and paths do not redirect messages', () => {
        expect(routeChatMessage('mail user@codex or inspect ./src@codex', PARTICIPANTS).recipientId).toBeNull();
        expect(routeChatMessage('hello everyone', PARTICIPANTS, 'pt_claude').recipientId).toBe('pt_claude');
        expect(routeChatMessage('hello @codex', PARTICIPANTS, 'pt_claude').recipientId).toBe('pt_codex');
    });

    test('rejects ambiguous and missing recipients instead of broadcasting or choosing one', () => {
        expect(() => routeChatMessage('Hey @missing, hello', PARTICIPANTS)).toThrow('not sent');
        expect(() => routeChatMessage('Hey @codex, hello', [...PARTICIPANTS, {...PARTICIPANTS[1]!, participantId: 'pt_other'}])).toThrow('Several');
        expect(() => routeChatMessage('@codex', PARTICIPANTS)).toThrow('Add a message');
        expect(() => routeChatMessage('Hey @codex, hello', PARTICIPANTS.map((participant) => ({...participant, left: true})))).toThrow('not sent');
    });

    test('multiple mentions preserve order, deduplicate and support all without implicit broadcasts', () => {
        expect(routeChatMessage('Hey @codex,@claude and @CODEX, review this', PARTICIPANTS)).toMatchObject({recipientId: null, recipientIds: ['pt_codex', 'pt_claude']});
        expect(routeChatMessage('@all review this', PARTICIPANTS)).toEqual({text: '@all review this', recipientId: null, allRecipients: true});
        expect(() => routeChatMessage('@all @missing please review', PARTICIPANTS)).toThrow('not sent');
        expect(() => routeChatMessage('@codex @claude', PARTICIPANTS)).toThrow('Add a message');
        expect(() => routeChatMessage('@all', PARTICIPANTS)).toThrow('Add a message');
        expect(routeChatMessage('hello everyone', PARTICIPANTS)).toEqual({text: 'hello everyone', recipientId: null, allRecipients: true});
    });
});

function plain(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('detecting a mention', () => {
    test('quoted names route and complete after a rename to a name containing spaces', () => {
        const members = [{participantId: 'pt_human', displayName: 'New Name', left: false, revoked: false}];
        expect(routeChatMessage('Hello @"New Name"', members).recipientId).toBe('pt_human');
        expect(() => routeChatMessage('Hello @"New Name', members)).toThrow('Close the quoted');
        expect(() => routeChatMessage('@"New Name"', members)).toThrow('Add a message');
        expect(currentMention('Hello @"New N')).toBe('New N');
        expect(currentMention('Hello @"New Name" ')).toBeNull();
        expect(applyMention('Hello @New', 'New Name ')).toBe('Hello @"New Name" ');
        expect(applyMention('Hello @"New N', 'New Name ')).toBe('Hello @"New Name" ');
        const escaped = [{...members[0]!, displayName: 'New "Name"'}];
        const completed = applyMention('Hello @New', 'New "Name" ');
        expect(routeChatMessage(completed, escaped).recipientId).toBe('pt_human');
    });
    test('test_an_at_sign_opens_the_completer', () => {
        expect(currentMention('@')).toBe('');
        expect(currentMention('@c')).toBe('c');
        expect(currentMention('hello @cl')).toBe('cl');
    });

    test('test_it_closes_once_the_name_is_followed_by_a_space', () => {
        expect(currentMention('@claude ')).toBeNull();
        expect(currentMention('@claude take this')).toBeNull();
    });

    test('test_an_at_sign_inside_a_word_is_not_a_mention', () => {
        // Otherwise an email address or a path would open the completer.
        expect(currentMention('mail me at hugo@example')).toBeNull();
        expect(currentMention('./src@v2')).toBeNull();
    });

    test('test_it_reads_from_the_cursor_not_the_end_of_the_line', () => {
        expect(currentMention('@cl and more', 3)).toBe('cl');
    });
});

describe('matching', () => {
    test('test_a_prefix_narrows_as_you_type', () => {
        expect(matchNames('c', NAMES)).toEqual(['claude', 'codex', 'cursor']);
        expect(matchNames('cl', NAMES)).toEqual(['claude']);
        expect(matchNames('', NAMES)).toEqual(NAMES);
    });

    test('test_matching_ignores_case', () => {
        expect(matchNames('CL', NAMES)).toEqual(['claude']);
    });

    test('test_prefix_matches_come_before_substring_matches', () => {
        expect(matchNames('u', ['hugo', 'ursula'])).toEqual(['ursula', 'hugo']);
    });

    test('test_nothing_matches_a_name_nobody_has', () => {
        expect(matchNames('zz', NAMES)).toEqual([]);
    });
});

describe('completing', () => {
    test('test_tab_advances_only_as_far_as_the_matches_agree', () => {
        expect(commonPrefix(['claude', 'codex', 'cursor'])).toBe('c');
        expect(commonPrefix(['codex', 'coder'])).toBe('code');
        expect(commonPrefix(['claude'])).toBe('claude');
    });

    test('test_applying_replaces_only_the_partial', () => {
        expect(applyMention('@cl', 'claude')).toBe('@claude');
        expect(applyMention('please @co', 'codex')).toBe('please @codex');
    });
});

describe('rendering', () => {
    test('test_the_typed_part_is_highlighted_and_the_rest_is_quiet', () => {
        const line = renderSuggestions('cl', ['claude']);
        // The name is split by colour codes, which is the point: "cl" lit, "aude" quiet.
        expect(plain(line)).toContain('claude');
        expect(line).toContain(`${BOLD}cl`);
        expect(line).toContain(`${DIM}aude`);
    });

    test('test_every_match_is_listed_not_just_the_first', () => {
        expect(plain(renderSuggestions('c', ['claude', 'codex', 'cursor']))).toContain('claude');
        expect(plain(renderSuggestions('c', ['claude', 'codex', 'cursor']))).toContain('codex');
        expect(plain(renderSuggestions('c', ['claude', 'codex', 'cursor']))).toContain('cursor');
    });

    test('test_an_empty_match_list_says_so_rather_than_showing_nothing', () => {
        expect(renderSuggestions('zz', [])).toContain('no participant matches @zz');
    });

    test('test_truncation_never_cuts_an_escape_sequence_in_half', () => {
        const many = Array.from({length: 6}, (_, index) => `participant-with-a-long-name-${index}`);
        const line = renderSuggestions('participant', many, 40);
        expect(plain(line).length).toBeLessThanOrEqual(40);
        // A half-written escape would leave the rest of the terminal coloured.
        expect(/\u001b\[[0-9;]*$/.test(line)).toBe(false);
        expect(line.endsWith('\u001b[0m')).toBe(true);
    });

    test('test_a_long_roster_is_truncated_with_a_count', () => {
        const many = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
        expect(renderSuggestions('a', many)).toContain('+2 more');
    });
});

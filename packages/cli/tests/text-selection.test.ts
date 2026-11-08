import {expect, test} from 'vitest';

import {countClick, MULTI_CLICK_MS, wordAt} from '../src/text-selection.js';

const measure = (text: string): number => [...text].reduce((width, character) => width + (/\p{Extended_Pictographic}|[　-鿿]/u.test(character) ? 2 : 1), 0);

function word(line: string, column: number): string | null {
    const range = wordAt(line, column, measure);
    return range ? line.slice(range.start, range.end) : null;
}

test('test_a_double_click_selects_the_word_under_it', () => {
    expect(word('20:24  claude → codex  Review of fix', 9)).toBe('claude');
    expect(word('20:24  claude → codex  Review of fix', 0)).toBe('20:24');
    expect(word('20:24  claude → codex', 6)).toBeNull();
    expect(word('short', 40)).toBeNull();
});

test('test_ids_paths_and_addresses_select_whole_and_trailing_punctuation_is_left_out', () => {
    expect(word('pairlobby receiver start --room rm_C4AADNTWSBB8N6BS7EYVN2A85D --yes', 40)).toBe('rm_C4AADNTWSBB8N6BS7EYVN2A85D');
    expect(word('see /private/tmp/claude-501/r2.patch.', 10)).toBe('/private/tmp/claude-501/r2.patch');
    expect(word('it is done.', 7)).toBe('done');
    expect(word('it is done.', 10)).toBe('done.');
    expect(word('(NameError, _CircularAnnotationError)', 3)).toBe('NameError');
});

test('test_wide_characters_count_two_columns', () => {
    expect(word('🙂 hello 世界', 3)).toBe('hello');
    expect(word('🙂 hello 世界', 10)).toBe('世界');
});

test('test_clicks_count_up_to_three_at_the_same_cell_then_start_over', () => {
    const first = countClick(undefined, 4, 2, 1000);
    const second = countClick(first, 4, 2, 1200);
    const third = countClick(second, 4, 2, 1400);
    expect([first.count, second.count, third.count, countClick(third, 4, 2, 1500).count]).toEqual([1, 2, 3, 1]);
    expect(countClick(first, 5, 2, 1100).count).toBe(1);
    expect(countClick(first, 4, 2, 1000 + MULTI_CLICK_MS + 1).count).toBe(1);
});

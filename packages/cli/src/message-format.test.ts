import {stripVTControlCharacters} from 'node:util';

import {expect, test} from 'vitest';

import {collapseMessage, formatMessageLines, formatMessageText} from './message-format.js';

const plain = (text: string) => stripVTControlCharacters(text);
const BOLD = '\u001b[1m', BOLD_OFF = '\u001b[22m', UNDERLINE = '\u001b[4m', UNDERLINE_OFF = '\u001b[24m', CODE = '\u001b[36m', COLOR_OFF = '\u001b[39m', QUIET = '\u001b[90m';

test('test_bold_emphasis_and_code_are_styled_and_their_markers_removed', () => {
    expect(formatMessageText('This is **bold** and __also bold__.')).toBe(`This is ${BOLD}bold${BOLD_OFF} and ${BOLD}also bold${BOLD_OFF}.`);
    expect(formatMessageText('An *emphasised* and _another_ word')).toBe(`An ${UNDERLINE}emphasised${UNDERLINE_OFF} and ${UNDERLINE}another${UNDERLINE_OFF} word`);
    expect(formatMessageText('Run `npm test` then ``a `tick` inside``')).toBe(`Run ${CODE}npm test${COLOR_OFF} then ${CODE}a \`tick\` inside${COLOR_OFF}`);
    expect(formatMessageText('**bold with *emphasis* inside**')).toBe(`${BOLD}bold with ${UNDERLINE}emphasis${UNDERLINE_OFF} inside${BOLD_OFF}`);
    expect(plain(formatMessageText('See [the docs](https://pairlobby.com/docs) first'))).toBe('See the docs (https://pairlobby.com/docs) first');
});

test('test_markers_without_a_partner_and_markers_inside_words_stay_as_written', () => {
    for (const text of ['a ** b', 'unclosed **bold', '2 * 3 * 4', 'snake_case_name and other_name', 'file_name.txt', '5*3*2', 'a _ b _ c', 'price: *', '`unclosed code', '[not a link](nowhere)', 'star**', '__init__.py']) {
        expect(formatMessageText(text), text).toBe(text);
    }
    // Nothing inside code is read as markup.
    expect(plain(formatMessageText('`**not bold** and _not emphasis_`'))).toBe('**not bold** and _not emphasis_');
    expect(formatMessageText('`**x**`')).toBe(`${CODE}**x**${COLOR_OFF}`);
});

test('test_headings_lists_quotes_and_rules_are_drawn_line_by_line', () => {
    const lines = formatMessageLines('# Plan\n\n- first\n* second with **weight**\n  - nested\n1. one\n2) two\n\n> quoted *text*\n\n---\nplain');
    expect(lines.map(plain)).toEqual(['Plan', '', '• first', '• second with weight', '  • nested', '1. one', '2) two', '', '▎ quoted text', '', '────────', 'plain']);
    expect(lines[0]).toBe(`${BOLD}Plan${BOLD_OFF}`);
    expect(lines[3]).toContain(`${BOLD}weight${BOLD_OFF}`);
    expect(plain(formatMessageText('#hashtag is not a heading\n-not a list'))).toBe('#hashtag is not a heading\n-not a list');
});

test('test_fenced_blocks_keep_their_text_and_json_is_re_indented_and_coloured', () => {
    const code = formatMessageLines('Before\n```ts\nconst a = **1**;\n  indented_name\n```\nAfter');
    expect(code.map(plain)).toEqual(['Before', '│ const a = **1**;', '│   indented_name', 'After']);
    expect(code[1]).toBe(`${QUIET}│${COLOR_OFF} ${CODE}const a = **1**;${COLOR_OFF}`);

    const json = formatMessageLines('```json\n{"name":"room","open":true,"seats":[1,2.5],"note":null}\n```');
    expect(json.map(plain)).toEqual(['│ {', '│   "name": "room",', '│   "open": true,', '│   "seats": [', '│     1,', '│     2.5', '│   ],', '│   "note": null', '│ }']);
    expect(json[1]).toContain('\u001b[94m"name"\u001b[39m:');
    expect(json[1]).toContain('\u001b[32m"room"\u001b[39m');
    expect(json[2]).toContain('\u001b[35mtrue\u001b[39m');
    expect(json[4]).toContain('\u001b[33m1\u001b[39m');

    // JSON that does not parse is shown as it was written, like any other code.
    expect(formatMessageLines('```json\n{"broken": \n```').map(plain)).toEqual(['│ {"broken": ']);
    // A ``` block is not parsed as JSON unless it says so; a txt block is kept exactly.
    expect(formatMessageLines('```\n{"a":1}\n```').map(plain)).toEqual(['│ {"a":1}']);
    expect(formatMessageLines('~~~txt\n  spaced   out\n~~~').map(plain)).toEqual(['│   spaced   out']);
});

test('test_an_unclosed_fence_does_not_swallow_the_rest_of_the_message', () => {
    expect(formatMessageLines('```js\nconst a = 1;\nand then **this**').map(plain)).toEqual(['```js', 'const a = 1;', 'and then this']);
});

test('test_a_message_cannot_inject_terminal_control_sequences', () => {
    const hostile = 'safe \u001b[31mred\u001b[0m \u001b]0;title\u0007 \u001b[2J\u0008\u0000 **ok**\ttab';
    const drawn = formatMessageText(hostile);
    expect(plain(drawn)).toBe('safe red   ok    tab');
    expect(drawn.match(/\u001b\[[0-9;]*m/g)).toEqual([BOLD, BOLD_OFF]);
    expect(drawn).not.toMatch(/\u001b\[2J|\u001b\]|\u0007|\u0000|\u0008/);
});

test('test_collapsing_shows_the_first_line_and_counts_the_rest', () => {
    const long = 'First **line**\n\nsecond\n- third\n```json\n{"a":1}\n```';
    const folded = collapseMessage(long);
    expect(plain(folded.line)).toBe('First line … +5 lines');
    expect(folded.line).toContain(`${BOLD}line${BOLD_OFF}`);
    expect(folded.hiddenLines).toBe(5);
    expect(collapseMessage('\n\nonly this')).toEqual({line: 'only this', hiddenLines: 0});
    expect(plain(collapseMessage('one\ntwo').line)).toBe('one … +1 line');
    expect(collapseMessage('   ')).toEqual({line: '', hiddenLines: 0});
});

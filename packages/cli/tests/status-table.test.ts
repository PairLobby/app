import {expect, test} from 'vitest';

import {compactTimestamp, statusTable} from '../src/status-table.js';
import type {StatusRow} from '../src/status-table.js';

const segmenter = new Intl.Segmenter();
const WIDE = /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

/** Terminal cells: wide characters and emoji take two, a combining sequence takes its base's width. */
function measure(text: string): number {
    let width = 0;
    for (const {segment} of segmenter.segment(text)) width += WIDE.test(segment) ? 2 : 1;
    return width;
}

const NOW = new Date(2026, 9, 2, 11, 45, 0).getTime();
const at = (hours: number, minutes: number, seconds: number) => new Date(2026, 9, 2, hours, minutes, seconds).getTime();

/** The rows from the reported screenshot. */
const screenshot: StatusRow[] = [
    {id: 'a', name: 'agent-VKN-2249', receipt: {kind: 'received', at: at(11, 40, 34)}, action: 'No response requested'},
    {id: 'b', name: 'agent-VKN-2248', receipt: {kind: 'received', at: at(11, 40, 35)}, action: 'No response requested'},
    {id: 'c', name: 'agent-VKN-2250', receipt: {kind: 'received', at: at(11, 40, 36)}, action: 'No response requested'},
    {id: 'd', name: 'agent-VKN-2253', receipt: {kind: 'read', at: at(11, 41, 2)}, action: 'Done'},
];

function lines(rows: StatusRow[], columns: number): string[] {
    return statusTable(rows, {columns, rows: 40, measure, now: NOW}).content.split('\n');
}

/** Display columns where " | " separators sit, so header and body alignment can be compared. */
function separators(line: string): number[] {
    const found: number[] = [];
    let column = 0;
    const cells = [...segmenter.segment(line)].map((part) => part.segment);
    for (let index = 0; index < cells.length; index++) {
        if (cells[index] === '|' && cells[index - 1] === ' ' && cells[index + 1] === ' ') {
            found.push(column);
        }
        column += measure(cells[index]!);
    }
    return found;
}

test('test_the_screenshot_rows_fit_one_line_each_without_prefixes', () => {
    const rendered = lines(screenshot, 120);
    expect(rendered).toHaveLength(screenshot.length + 1);
    expect(rendered[0]).toMatch(/^Participant\s+\| Receipt\s+\| Action$/);
    expect(rendered.join('\n')).not.toContain('Message status');
    expect(rendered.join('\n')).not.toContain('Received');
    expect(rendered[1]).toBe('agent-VKN-2249 | 11:40:34      | No response requested');
    expect(rendered[4]).toBe('agent-VKN-2253 | Read 11:41:02 | Done');
});

test.each([40, 60, 80, 100, 140])('test_every_line_fits_and_separators_align_at_%i_columns', (columns) => {
    const rows: StatusRow[] = [...screenshot, {id: 'e', name: 'reviewer with a long display name', receipt: {kind: 'unconfirmed'}, action: 'Waiting', reason: 'Waiting for the integration tests to finish on the other machine'}];
    const layout = statusTable(rows, {columns, rows: 40, measure, now: NOW});
    const rendered = layout.content.split('\n');
    expect(rendered).toHaveLength(rows.length + 1);
    expect(layout.width).toBeLessThanOrEqual(Math.min(96, columns - 2));
    for (const line of rendered) {
        expect(measure(line)).toBeLessThanOrEqual(layout.width - 4);
    }
    const heading = separators(rendered[0]!);
    expect(heading).toHaveLength(2);
    for (const line of rendered.slice(1)) {
        expect(separators(line).slice(0, 2)).toEqual(heading);
    }
});

test('test_narrow_terminals_shorten_labels_that_stay_distinct', () => {
    const rows: StatusRow[] = [
        {id: 'a', name: 'codex', receipt: {kind: 'received', at: at(11, 40, 34)}, action: 'No response requested'},
        {id: 'b', name: 'claude', receipt: {kind: 'read', at: at(11, 40, 35)}, action: 'No action needed'},
    ];
    const rendered = lines(rows, 40);
    expect(rendered[1]).toContain('Not asked');
    expect(rendered[2]).toContain('No action');
    expect(rendered[1]).toContain('11:40');
    expect(rendered[1]).not.toContain('11:40:34');
});

test('test_receipt_states_are_distinct_without_colour', () => {
    const rendered = lines([
        {id: 'a', name: 'one', receipt: {kind: 'received', at: at(10, 0, 0)}, action: 'Working'},
        {id: 'b', name: 'two', receipt: {kind: 'read', at: at(10, 0, 0)}, action: 'Waiting', reason: 'review'},
        {id: 'c', name: 'three', receipt: {kind: 'unconfirmed'}, action: 'Queued'},
    ], 100);
    expect(rendered[1]).toMatch(/\| 10:00:00\s+\| Working$/);
    expect(rendered[2]).toMatch(/\| Read 10:00:00 \| Waiting — review$/);
    expect(rendered[3]).toMatch(/\| Unconfirmed\s+\| Queued$/);
});

test('test_long_reasons_and_names_are_clipped_not_wrapped', () => {
    const rendered = lines([
        {id: 'a', name: 'agent-with-an-extremely-long-name-that-keeps-going', receipt: {kind: 'read', at: at(9, 0, 0)}, action: 'Declined', reason: 'This reason is far longer than any terminal row could hold in a sensible status table, so it must be cut'},
        {id: 'b', name: 'agent-with-an-extremely-long-name-that-differs', receipt: {kind: 'read', at: at(9, 0, 0)}, action: 'Done'},
    ], 60);
    expect(rendered).toHaveLength(3);
    expect(rendered[1]).toContain('…');
    expect(rendered[1]).toContain('Declined');
});

test('test_wide_characters_emoji_and_combining_marks_keep_columns_aligned', () => {
    const rows: StatusRow[] = [
        {id: 'a', name: '设计评审', receipt: {kind: 'received', at: at(8, 0, 0)}, action: 'Done'},
        {id: 'b', name: 'robot 🤖', receipt: {kind: 'read', at: at(8, 0, 0)}, action: 'Working'},
        {id: 'c', name: 'café́', receipt: {kind: 'unconfirmed'}, action: 'Queued'},
        {id: 'd', name: 'line\nbreak\tand\u0007bell', receipt: {kind: 'unconfirmed'}, action: 'Queued'},
    ];
    const rendered = lines(rows, 80);
    const heading = separators(rendered[0]!);
    for (const line of rendered.slice(1)) {
        expect(separators(line).slice(0, 2)).toEqual(heading);
    }
    expect(rendered[4]).toMatch(/^line break andbell/);
});

test('test_timestamps_shorten_by_age_and_never_lie', () => {
    expect(compactTimestamp(at(9, 5, 7), NOW)).toBe('09:05:07');
    expect(compactTimestamp(new Date(2026, 2, 4, 9, 5, 7).getTime(), NOW)).toBe('03-04 09:05:07');
    expect(compactTimestamp(new Date(2025, 11, 31, 23, 59, 0).getTime(), NOW)).toBe('2025-12-31 23:59:00');
    expect(compactTimestamp(at(9, 5, 7), NOW, 'minutes')).toBe('09:05');
});

test('test_a_long_roster_scrolls_instead_of_growing', () => {
    const rows = Array.from({length: 30}, (_, index): StatusRow => ({id: `p${index}`, name: `agent-${index}`, receipt: {kind: 'unconfirmed'}, action: 'Queued'}));
    const layout = statusTable(rows, {columns: 100, rows: 30, measure, now: NOW});
    expect(layout.scrollable).toBe(true);
    expect(layout.height).toBeLessThanOrEqual(12);
    expect(layout.content.split('\n')[0]).not.toContain('scroll');
});

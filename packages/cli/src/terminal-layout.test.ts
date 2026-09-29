import {expect, test} from 'vitest';
import {popupLayout, visibleMessageRow} from './terminal-layout.js';

const bounds = {columns: 110, rows: 30, measure: (text: string) => [...text].length};

test('popups shrink to the longest row and cap both dimensions with accessible overflow', () => {
    const small = popupLayout(['Working on an answer', 'codex — 157s'], bounds);
    expect(small.width).toBe('Working on an answer'.length + 4);
    expect(small.height).toBe(4);
    expect(small.scrollable).toBe(false);
    const large = popupLayout(['Confirmed receipts', ...Array.from({length: 30}, () => 'A'.repeat(200))], bounds);
    expect(large.width).toBe(64);
    expect(large.height).toBe(12);
    expect(large.content).toContain('(scroll)');
    expect(large.content.split('\n').every((line) => line.length <= 60)).toBe(true);
    expect(large.content.replaceAll('\n', '')).toContain('A'.repeat(200));
});

test('small terminals constrain popups without splitting Unicode graphemes', () => {
    const result = popupLayout(['Working', '名👩‍💻'.repeat(8)], {columns: 16, rows: 10, measure: (text) => [...new Intl.Segmenter().segment(text)].length * 2});
    expect(result.width).toBeLessThanOrEqual(14);
    expect(result.height).toBeLessThanOrEqual(5);
    expect(result.content.replaceAll('\n', '')).toContain('名👩‍💻'.repeat(8));
});

test('Seen follows the top, bottom or middle of only its own visible message', () => {
    expect(visibleMessageRow(8, 3, 5, 20)).toBe(8);
    expect(visibleMessageRow(8, 40, 30, 20)).toBe(47);
    expect(visibleMessageRow(8, 100, 30, 20)).toBe(39);
    expect(visibleMessageRow(8, 3, 11, 20)).toBeNull();
    expect(visibleMessageRow(50, 2, 30, 20)).toBeNull();
    expect(visibleMessageRow(0, 100, 50, 1)).toBe(50);
});

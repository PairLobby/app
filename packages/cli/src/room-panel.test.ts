import {expect, test} from 'vitest';

import {panelColumns} from './room-panel.js';
import type {RoomPanelRow} from './room-panel.js';

const ROWS: RoomPanelRow[] = [
    {id: 'inactivity', label: 'Managed task inactivity timeout', value: '10 minutes', section: 'Agents', action: {kind: 'menu', load: async () => { throw new Error('unused'); }}},
    {id: 'reset', label: 'Reset all settings', value: 'Back to the built-in defaults', section: 'Reset'},
];

test('test_labels_are_shown_whole_when_every_row_fits', () => {
    expect(panelColumns(ROWS, 120)).toEqual({sectionWidth: 10, labelWidth: 31});
});

test('test_labels_shrink_before_values_on_a_narrower_terminal', () => {
    // 70 columns leave 70 - 10 - 1 - 3 - 29 = 27 for labels.
    expect(panelColumns(ROWS, 70)).toEqual({sectionWidth: 10, labelWidth: 27});
});

test('test_labels_keep_the_old_minimum_share_on_a_narrow_terminal', () => {
    expect(panelColumns(ROWS, 40)).toEqual({sectionWidth: 10, labelWidth: 14});
});

test('test_long_sections_widen_their_column_up_to_a_cap', () => {
    const rows = [{...ROWS[1]!, section: 'A very long section name'}];
    expect(panelColumns(rows, 120).sectionWidth).toBe(16);
});

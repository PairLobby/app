import {PassThrough} from 'node:stream';

import blessed from 'blessed';
import {expect, test} from 'vitest';

import {RoomPanel, panelColumns} from '../src/room-panel.js';
import type {RoomPanelPage, RoomPanelRow} from '../src/room-panel.js';

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

type Setting = {value: string; saved: string[]; confirm?: boolean};

function settingsPanel(setting: Setting) {
    const output = Object.assign(new PassThrough(), {isTTY: true, columns: 100, rows: 30});
    const screen = blessed.screen({input: new PassThrough() as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, terminal: 'xterm-256color', warnings: false});
    const page = (): RoomPanelPage => ({id: 'settings', title: 'Room settings', note: '', reload: async () => page(), rows: [{id: 'type', label: 'Room type', value: setting.value, section: 'Privacy', action: {kind: 'edit', initial: setting.value, hint: '', choices: [{label: 'Private', value: 'private'}, {label: 'Team', value: 'team'}, {label: 'Public', value: 'public'}, {label: 'Custom', value: '', custom: true}], ...(setting.confirm ? {confirm: (value: string) => `Make it ${value}?`} : {}), save: async (value) => { setting.saved.push(value); setting.value = value; }}}]});
    const panel = new RoomPanel({screen, close: () => {}});
    panel.show(page());
    return {panel, screen};
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

test('test_left_and_right_save_the_neighbouring_choice_and_wrap_past_custom_ones', async () => {
    const setting: Setting = {value: 'private', saved: []};
    const {panel, screen} = settingsPanel(setting);
    panel.key(undefined, {name: 'right'});
    await settled();
    panel.key(undefined, {name: 'right'});
    await settled();
    panel.key(undefined, {name: 'right'});
    await settled();
    panel.key(undefined, {name: 'left'});
    await settled();
    expect(setting.saved).toEqual(['team', 'public', 'private', 'public']);
    screen.destroy();
});

test('test_a_choice_that_asks_for_confirmation_still_asks_after_an_arrow', async () => {
    const setting: Setting = {value: 'private', saved: [], confirm: true};
    const {panel, screen} = settingsPanel(setting);
    panel.key(undefined, {name: 'right'});
    await settled();
    expect(setting.saved).toEqual([]);
    panel.key(undefined, {name: 'right'});
    panel.key(undefined, {name: 'enter'});
    await settled();
    expect(setting.saved).toEqual(['team']);
    screen.destroy();
});

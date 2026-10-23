import blessed from 'blessed';
import {expect, test} from 'vitest';
import {teachEmojiWidth, terminalName} from '../src/terminal-program.js';
import type {BlessedUnicode} from '../src/terminal-program.js';

test('a Windows console without TERM gets the xterm profile; everything else keeps its own', () => {
    expect(terminalName('win32', undefined)).toBe('xterm-256color');
    expect(terminalName('win32', '')).toBe('xterm-256color');
    expect(terminalName('win32', 'xterm')).toBeUndefined();
    expect(terminalName('darwin', undefined)).toBeUndefined();
    expect(terminalName('linux', 'xterm-256color')).toBeUndefined();
});

test('the xterm profile keeps gray distinct from black and reports the mouse, unlike windows-ansi', () => {
    type Profile = {colors: number; strings: Record<string, string | undefined>};
    const tput = (blessed as unknown as {tput: (options: {terminal: string; extended: boolean}) => Profile}).tput;
    const chosen = tput({terminal: 'xterm-256color', extended: false});
    const fallback = tput({terminal: 'windows-ansi', extended: false});
    expect(chosen.colors).toBe(256);
    expect(chosen.strings.key_mouse).toBeTruthy();
    expect(fallback.colors).toBe(8);
    expect(fallback.strings.key_mouse).toBeUndefined();
});

test('test_emoji_take_two_cells_and_get_the_placeholder_blessed_gives_wide_characters', () => {
    const unicode: BlessedUnicode = {charWidth: () => 1, chars: {all: /([\u3040-\u309f])/g}};
    teachEmojiWidth(unicode);
    teachEmojiWidth(unicode);
    expect('💻 a ぁ ▪'.replace(unicode.chars.all as RegExp, '$1\x03')).toBe('💻\x03 a ぁ\x03 ▪');
    expect(unicode.charWidth('💻')).toBe(2);
    expect(unicode.charWidth('▪')).toBe(1);
    expect(unicode.charWidth('a')).toBe(1);
});

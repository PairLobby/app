import {createInterface} from 'node:readline';
import {PassThrough} from 'node:stream';
import {expect, test} from 'vitest';
import {composerLayout, editMultilineDraft, insertDraft, insertsLineBreak} from '../src/chat-composer.js';
import {ChatKeyboard, enhancedKey} from '../src/chat-keyboard.js';

const measure = (text: string): number => [...text].reduce((width, character) => width + (/\p{Extended_Pictographic}|[　-鿿]/u.test(character) ? 2 : 1), 0);

test('modified Enter inserts a literal newline and only plain Enter submits the complete draft', () => {
    const source = new PassThrough();
    const output = new PassThrough();
    const input = createInterface({input: source, output, terminal: true});
    const submitted: string[] = [];
    input.on('line', (line) => submitted.push(line));
    try {
        input.write('firstlast');
        Object.assign(input, {cursor: 5});
        Object.assign(input, insertDraft({line: input.line, cursor: input.cursor}, '\n'));
        Object.assign(input, editMultilineDraft({line: input.line, cursor: input.cursor}, 'middle', {}));
        expect(submitted).toEqual([]);
        const edit = editMultilineDraft({line: input.line, cursor: input.cursor}, '', {name: 'return'});
        if (edit.submit !== undefined) {
            input.emit('line', edit.submit);
        }
        expect(submitted).toEqual(['first\nmiddlelast']);
        expect(insertsLineBreak({name: 'enter', shift: true})).toBe(true);
        expect(insertsLineBreak({name: 'return', meta: true})).toBe(true);
        expect(insertsLineBreak({name: 'linefeed', sequence: '\n'})).toBe(true);
        expect(insertsLineBreak({name: 'j', ctrl: true, sequence: '\x1b[106;5u'})).toBe(true);
        expect(insertsLineBreak({name: 'enter', sequence: '\r'})).toBe(false);
    } finally {
        input.close();
        source.destroy();
        output.destroy();
    }
});

test('multiline edits preserve newline boundaries, merge lines on backspace and delete complete graphemes', () => {
    expect(editMultilineDraft({line: 'first\nsecond', cursor: 6}, '', {name: 'backspace'})).toEqual({line: 'firstsecond', cursor: 5});
    expect(editMultilineDraft({line: 'first\nsecond', cursor: 9}, '', {name: 'home'}).cursor).toBe(6);
    expect(editMultilineDraft({line: 'first\nsecond', cursor: 9}, '', {name: 'up'}).cursor).toBe(3);
    expect(editMultilineDraft({line: 'first\nsecond', cursor: 3}, '', {name: 'down'}).cursor).toBe(9);
    expect(editMultilineDraft({line: 'first\n🙂ok', cursor: 8}, '', {name: 'backspace'})).toEqual({line: 'first\nok', cursor: 6});
});

test('multiline drafts wrap by terminal columns and keep the cursor visible in a bounded composer', () => {
    const baseline = {line: 'first\nsecond', cursor: 12, prompt: '> ', columns: 40, maxRows: 6, measure};
    expect(composerLayout(baseline)).toEqual({content: '> first\n  second', height: 2, cursorRow: 1, cursorColumn: 8});
    expect(composerLayout({...baseline, line: 'first\n', cursor: 6})).toEqual({content: '> first\n  ', height: 2, cursorRow: 1, cursorColumn: 2});
    const wrapped = composerLayout({...baseline, line: '🙂 世界 abc', cursor: 4, columns: 10});
    expect(wrapped.height).toBe(2);
    expect(wrapped.cursorColumn).toBe(7);
    const last = composerLayout({...baseline, line: 'a\nb\nc\nd', cursor: 7, maxRows: 2});
    expect(last).toEqual({content: '  c\n  d', height: 2, cursorRow: 1, cursorColumn: 3});
    expect(composerLayout({...baseline, line: 'a\nb\nc\nd', cursor: 0, maxRows: 2}).content).toBe('> a\n  b');
});

test('enhanced terminal keys preserve modifiers and do not confuse normal Return with a newline', () => {
    expect(enhancedKey('\x1b[13;2u')?.key).toMatchObject({name: 'enter', shift: true, meta: false});
    expect(enhancedKey('\x1b[13;3u')?.key).toMatchObject({name: 'enter', shift: false, meta: true});
    expect(enhancedKey('\x1b[27;2;13~')?.key).toMatchObject({name: 'enter', shift: true});
    expect(enhancedKey('\x1b[13u')?.key).toMatchObject({name: 'enter', shift: false, meta: false});
    expect(enhancedKey('\x1b[99;5u')?.key).toMatchObject({name: 'c', ctrl: true});
    expect(enhancedKey('\x1b[A')).toBeNull();
});

test('keyboard decoding handles split modified Enter, ignores releases, and preserves mouse and plain input', async () => {
    const source = new PassThrough();
    const keyboard = new ChatKeyboard(source);
    const text: string[] = [];
    const keys: string[] = [];
    keyboard.on('data', (chunk: Buffer) => text.push(chunk.toString()));
    keyboard.on('keypress', (_character: string | undefined, key) => keys.push(key.sequence));
    try {
        source.write('first\x1b[13;');
        source.write('2u');
        source.write('\x1b\r');
        source.write('\x1b[13;2:3u');
        source.write('second\x1b[<35;12;24M');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(keys).toEqual(['\x1b[13;2u', '\x1b\r']);
        expect(text.join('')).toBe('firstsecond\x1b[<35;12;24M');
    } finally {
        keyboard.destroy();
        source.destroy();
    }
});

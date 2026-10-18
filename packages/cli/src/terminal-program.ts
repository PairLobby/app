//! The blessed program shared by every full-screen view, with the terminal it should assume.

import blessed from 'blessed';

type TerminalProgramOptions = {extended: boolean; debug: boolean; terminal?: string};
export type WideCharacters = {[Symbol.replace]: (text: string, replacement: string) => string};
export type BlessedUnicode = {charWidth: (text: string | number, index?: number) => number; chars: {all: RegExp | WideCharacters}; emojiAware?: true};

const EMOJI = /(\p{Emoji_Presentation})/gu;

function isEmoji(point: number | undefined): boolean {
    return point !== undefined && point > 0xff && /\p{Emoji_Presentation}/u.test(String.fromCodePoint(point));
}

/**
 * Blessed counts an emoji such as 💻 as one cell while terminals draw it in two,
 * so everything after it on the row lands a column off and redraws garble the
 * screen. Give emoji the treatment blessed already gives wide CJK characters: a
 * placeholder cell after each one, and a width of two.
 */
export function teachEmojiWidth(unicode = (blessed as unknown as {unicode: BlessedUnicode}).unicode): void {
    if (unicode.emojiAware) {
        return;
    }
    const wide = unicode.chars.all as RegExp;
    const charWidth = unicode.charWidth;
    const all: WideCharacters = {[Symbol.replace]: (text, replacement) => wide[Symbol.replace](text, replacement).replace(EMOJI, replacement)};
    unicode.chars.all = all;
    unicode.charWidth = (text, index) => isEmoji(typeof text === 'number' ? text : text.codePointAt(index ?? 0)) ? 2 : charWidth(text, index);
    unicode.emojiAware = true;
}

/**
 * Windows consoles leave TERM unset, and blessed then assumes `windows-ansi`:
 * eight colors, so gray text is drawn black, and no mouse reporting, so hover
 * and click never arrive. The Windows 10+ console and Windows Terminal speak
 * the xterm sequences, so they get the same profile as macOS and Linux.
 */
export function terminalName(platform: string, term: string | undefined): string | undefined {
    return platform === 'win32' && !term ? 'xterm-256color' : undefined;
}

export function createTerminalProgram(): blessed.BlessedProgram {
    teachEmojiWidth();
    // Blessed's legacy compiler cannot parse some modern extended capabilities
    // (e.g. Setulc). Standard terminfo supplies all capabilities used by this UI.
    const options: TerminalProgramOptions = {extended: false, debug: false};
    const terminal = terminalName(process.platform, process.env.TERM);
    if (terminal) {
        options.terminal = terminal;
    }
    return blessed.program(options);
}

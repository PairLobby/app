//! Draws the Markdown agents write as terminal text: bold, emphasis, code, headings,
//! lists, quotes, links and fenced blocks, with JSON re-indented and coloured.
//!
//! Only the terminal chat uses this. Anything an agent reads, and `--json`, stay raw.
//! The message is cleaned of control characters first, so the only escape codes in the
//! result are the ones written here: a message cannot restyle or redraw the terminal.
//! Whatever is not recognised is shown as written; an unclosed `**` or fence never
//! swallows the rest of the message.

import {stripVTControlCharacters} from 'node:util';

// Attribute pairs the chat's screen can draw. It has no italics, so emphasis is underlined.
const BOLD: Pair = ['\u001b[1m', '\u001b[22m'];
const UNDERLINE: Pair = ['\u001b[4m', '\u001b[24m'];
const CODE: Pair = ['\u001b[36m', '\u001b[39m'];
const QUIET: Pair = ['\u001b[90m', '\u001b[39m'];
const JSON_KEY: Pair = ['\u001b[94m', '\u001b[39m'];
const JSON_STRING: Pair = ['\u001b[32m', '\u001b[39m'];
const JSON_NUMBER: Pair = ['\u001b[33m', '\u001b[39m'];
const JSON_LITERAL: Pair = ['\u001b[35m', '\u001b[39m'];

type Pair = [on: string, off: string];
type InlineRule = {pattern: RegExp; draw: (match: RegExpExecArray) => string};
export type CollapsedMessage = {line: string; hiddenLines: number};

const paint = (text: string, [on, off]: Pair) => `${on}${text}${off}`;

/** Control characters out, tabs to spaces, one kind of line ending. */
function clean(text: string): string {
    return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
}

// Tried in order at each position. Code comes first so nothing inside it is read as markup.
// Underscore emphasis must end a word, so names like __init__.py and file_name.txt are left alone.
const INLINE: InlineRule[] = [
    {pattern: /^(`+)(?!`)(.+?)(?<!`)\1(?!`)/, draw: (match) => paint(match[2]!, CODE)},
    {pattern: /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/, draw: (match) => `${paint(inline(match[1]!), UNDERLINE)} ${paint(`(${match[2]})`, QUIET)}`},
    {pattern: /^\*\*(?=\S)(.+?)(?<=\S)\*\*(?!\*)/, draw: (match) => paint(inline(match[1]!), BOLD)},
    {pattern: /^__(?=\S)(.+?)(?<=\S)__(?=$|\s|[.,;:!?)\]]+(?:\s|$))/u, draw: (match) => paint(inline(match[1]!), BOLD)},
    {pattern: /^\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?!\*)/, draw: (match) => paint(inline(match[1]!), UNDERLINE)},
    {pattern: /^_(?=[^\s_])(.+?)(?<=[^\s_])_(?=$|\s|[.,;:!?)\]]+(?:\s|$))/u, draw: (match) => paint(inline(match[1]!), UNDERLINE)},
];

/** One line's inline markup. A marker with no partner is kept as the character it is. */
function inline(text: string): string {
    let drawn = '';
    let index = 0;
    while (index < text.length) {
        const rest = text.slice(index);
        const previous = index > 0 ? text[index - 1]! : '';
        // An underscore or asterisk inside a word (snake_case, 2*3*4) is not emphasis.
        const opens = rest[0] === '`' || rest[0] === '[' || !/[\p{L}\p{N}]/u.test(previous) || (rest[0] === '*' && rest[1] === '*');
        const rule = opens && '`[*_'.includes(rest[0]!) ? INLINE.map((candidate) => ({candidate, match: candidate.pattern.exec(rest)})).find(({match}) => match) : undefined;
        if (rule?.match) {
            drawn += rule.candidate.draw(rule.match);
            index += rule.match[0].length;
        } else {
            drawn += rest[0];
            index += 1;
        }
    }
    return drawn;
}

/** Valid JSON, re-indented and coloured by token. Null when the text is not JSON. */
function jsonLines(source: string): string[] | null {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return null;
    }
    if (value === null || typeof value !== 'object') {
        return null;
    }
    return JSON.stringify(value, null, 2).split('\n').map((line) => line.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (token, text?: string, colon?: string, literal?: string) => {
        if (text !== undefined) {
            return colon ? `${paint(text, JSON_KEY)}${colon}` : paint(text, JSON_STRING);
        }
        return paint(token, literal ? JSON_LITERAL : JSON_NUMBER);
    }));
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w.+-]*)\s*$/;

/** The message as lines of styled text, not yet wrapped: the screen wraps to its own width. */
export function formatMessageLines(text: string): string[] {
    const source = clean(text).split('\n');
    const lines: string[] = [];
    for (let index = 0; index < source.length; index++) {
        const line = source[index]!;
        const fence = FENCE.exec(line);
        if (fence) {
            const marker = fence[1]!;
            const end = source.findIndex((candidate, at) => at > index && new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(candidate));
            if (end !== -1) {
                const body = source.slice(index + 1, end);
                const json = /^json[c5]?$/i.test(fence[2]!) ? jsonLines(body.join('\n')) : null;
                const bar = paint('│', QUIET);
                lines.push(...(json ?? body.map((code) => paint(code, CODE))).map((code) => `${bar} ${code}`));
                index = end;
                continue;
            }
            // An opening fence with no close is just text.
        }
        const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        const quote = /^ {0,3}>\s?(.*)$/.exec(line);
        const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
        if (heading) {
            lines.push(paint(inline(heading[2]!), BOLD));
        } else if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
            lines.push(paint('────────', QUIET));
        } else if (quote) {
            lines.push(`${paint('▎', QUIET)} ${inline(quote[1]!)}`);
        } else if (item) {
            lines.push(`${item[1]}${/\d/.test(item[2]!) ? item[2] : '•'} ${inline(item[3]!)}`);
        } else {
            lines.push(inline(line));
        }
    }
    return lines;
}

/** The message styled for the chat transcript. */
export function formatMessageText(text: string): string {
    return formatMessageLines(text).join('\n');
}

/**
 * A message folded to its first line that says anything, with how many more it has.
 * Zero hidden lines means there is nothing to fold: the message already is one line.
 */
export function collapseMessage(text: string): CollapsedMessage {
    const lines = formatMessageLines(text);
    const first = lines.findIndex((line) => stripVTControlCharacters(line).trim().length > 0);
    if (first === -1) {
        return {line: '', hiddenLines: 0};
    }
    const hiddenLines = lines.filter((line, index) => index !== first && stripVTControlCharacters(line).trim().length > 0).length;
    return {line: hiddenLines ? `${lines[first]} ${paint(`… +${hiddenLines} ${hiddenLines === 1 ? 'line' : 'lines'}`, QUIET)}` : lines[first]!, hiddenLines};
}

//! Double- and triple-click selection in the chat transcript, which keeps the mouse for its own
//! controls and so cannot leave selection to the terminal. A word ends where the VS Code terminal
//! ends one, so ids, paths and addresses select whole.

/** A selected span of one rendered line, in string offsets of its plain text. */
export type TextRange = {start: number; end: number};

const SEPARATORS = new Set([' ', '\t', '(', ')', '[', ']', '{', '}', '\'', ',', '"', '`', '─', '‘', '’', '“', '”', '|']);
const TRAILING = /[.,;:!?]+$/u;
const graphemes = new Intl.Segmenter();

/** The word under display column `column`, or null on a separator or past the end of the line. */
export function wordAt(line: string, column: number, measure: (text: string) => number): TextRange | null {
    const segments = [...graphemes.segment(line)];
    let width = 0;
    const hit = segments.findIndex(({segment}) => {
        width += measure(segment);
        return width > column;
    });
    if (hit < 0 || SEPARATORS.has(segments[hit]!.segment)) {
        return null;
    }
    let first = hit;
    while (first > 0 && !SEPARATORS.has(segments[first - 1]!.segment)) {
        first--;
    }
    let last = hit;
    while (last < segments.length - 1 && !SEPARATORS.has(segments[last + 1]!.segment)) {
        last++;
    }
    const start = segments[first]!.index;
    const end = segments[last]!.index + segments[last]!.segment.length;
    // "done." selects "done", unless the click was on the punctuation itself.
    const trimmed = start + line.slice(start, end).replace(TRAILING, '').length;
    return {start, end: trimmed > start && segments[hit]!.index < trimmed ? trimmed : end};
}

/** Clicks at the same cell within this window count as one double or triple click. */
export const MULTI_CLICK_MS = 500;

export type Click = {x: number; y: number; at: number; count: number};

/** The next click's count: 1, 2 or 3, starting over after a triple click or a move. */
export function countClick(previous: Click | undefined, x: number, y: number, at: number): Click {
    const repeated = previous && previous.x === x && previous.y === y && at - previous.at <= MULTI_CLICK_MS && previous.count < 3;
    return {x, y, at, count: repeated ? previous.count + 1 : 1};
}

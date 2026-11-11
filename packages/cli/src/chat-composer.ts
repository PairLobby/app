import type {Key} from 'node:readline';

export type Draft = {line: string; cursor: number};
export type ComposerOptions = Draft & {prompt: string; columns: number; maxRows: number; measure: (text: string) => number};
export type ComposerLayout = {content: string; height: number; cursorRow: number; cursorColumn: number};
export type DraftEdit = Draft & {submit?: string};

export function insertsLineBreak(key: Key): boolean {
    return key.name === 'linefeed' || key.sequence === '\n' || Boolean(key.ctrl && key.name === 'j') || ((key.name === 'enter' || key.name === 'return') && Boolean(key.shift || key.meta));
}

/** Insert literal text without handing embedded newlines to readline's submit handler. */
export function insertDraft(draft: Draft, text: string): Draft {
    return {line: draft.line.slice(0, draft.cursor) + text + draft.line.slice(draft.cursor), cursor: draft.cursor + text.length};
}

/** Readline's history and editing assume a single physical line; keep multiline edits literal. */
export function editMultilineDraft(draft: Draft, character: string, key: Key): DraftEdit {
    const {line, cursor} = draft;
    const start = line.lastIndexOf('\n', cursor - 1) + 1;
    const end = line.indexOf('\n', cursor);
    const right = end < 0 ? line.length : end;
    const previous = [...new Intl.Segmenter().segment(line.slice(0, cursor))].at(-1)?.index ?? 0;
    const next = cursor + ([...new Intl.Segmenter().segment(line.slice(cursor))][0]?.segment.length ?? 0);
    if (key.name === 'enter' || key.name === 'return') {
        return {line: '', cursor: 0, submit: line};
    }
    if (key.name === 'home' || key.ctrl && key.name === 'a') {
        return {...draft, cursor: start};
    }
    if (key.name === 'end' || key.ctrl && key.name === 'e') {
        return {...draft, cursor: right};
    }
    if (key.name === 'left') {
        return {...draft, cursor: previous};
    }
    if (key.name === 'right') {
        return {...draft, cursor: next};
    }
    if (key.name === 'up' && start > 0) {
        const before = line.lastIndexOf('\n', start - 2) + 1;
        return {...draft, cursor: Math.min(start - 1, before + cursor - start)};
    }
    if (key.name === 'down' && end >= 0) {
        const after = line.indexOf('\n', end + 1);
        return {...draft, cursor: Math.min(after < 0 ? line.length : after, end + 1 + cursor - start)};
    }
    if (key.name === 'backspace') {
        const from = key.meta || key.ctrl ? cursor - (line.slice(0, cursor).match(/\S+\s*$|\s+$/u)?.[0].length ?? 0) : previous;
        return {line: line.slice(0, from) + line.slice(cursor), cursor: from};
    }
    if (key.name === 'delete' || key.ctrl && key.name === 'd') {
        return {line: line.slice(0, cursor) + line.slice(next), cursor};
    }
    if (key.ctrl && key.name === 'k') {
        return {line: line.slice(0, cursor) + line.slice(right === cursor ? next : right), cursor};
    }
    if (key.ctrl && (key.name === 'u' || key.name === 'w')) {
        const from = key.name === 'u' ? start : cursor - (line.slice(0, cursor).match(/\S+\s*$|\s+$/u)?.[0].length ?? 0);
        return {line: line.slice(0, from) + line.slice(cursor), cursor: from};
    }
    if (key.name === 'tab') {
        return insertDraft(draft, '    ');
    }
    return character && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/u.test(character) ? insertDraft(draft, character) : draft;
}

export function composerLayout({line, cursor, prompt, columns, maxRows, measure}: ComposerOptions): ComposerLayout {
    const prefixWidth = measure(prompt);
    const width = Math.max(1, columns - prefixWidth - 1);
    const rows: string[] = [];
    let current = '';
    let offset = 0;
    let cursorRow = 0;
    let cursorColumn = prefixWidth;
    for (const {segment} of new Intl.Segmenter().segment(line)) {
        if (segment !== '\n' && current && measure(current + segment) > width) {
            rows.push(current);
            current = '';
        }
        if (offset === cursor) {
            cursorRow = rows.length;
            cursorColumn = prefixWidth + measure(current);
        }
        if (segment === '\n') {
            rows.push(current);
            current = '';
        } else {
            current += segment;
        }
        offset += segment.length;
    }
    if (cursor >= offset) {
        cursorRow = rows.length;
        cursorColumn = prefixWidth + measure(current);
    }
    rows.push(current);
    const height = Math.min(rows.length, Math.max(1, maxRows));
    const first = Math.max(0, Math.min(cursorRow - height + 1, rows.length - height));
    return {
        content: rows.slice(first, first + height).map((text, index) => `${first + index === 0 ? prompt : ' '.repeat(prefixWidth)}${text}`).join('\n'),
        height,
        cursorRow: cursorRow - first,
        cursorColumn: Math.min(columns - 1, cursorColumn)
    };
}

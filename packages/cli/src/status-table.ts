//! The message-status popup as a table: one line per participant, columns that
//! line up with their heading, and content that narrows in a fixed order rather
//! than wrapping words or dates onto the next line.

import {stripVTControlCharacters} from 'node:util';

import type {PopupLayout} from './terminal-layout.js';

export type ReceiptCell = {kind: 'read' | 'received'; at: number} | {kind: 'unconfirmed'};

export type StatusRow = {id: string; name: string; receipt: ReceiptCell; action: string; reason?: string | undefined};

export type TableBounds = {columns: number; rows: number; measure: (text: string) => number; now?: number};

type Precision = 'seconds' | 'minutes';

const HEADINGS = ['Participant', 'Receipt', 'Action'] as const;
/** On a narrow terminal the first heading gives way before any participant's action does. */
const NARROW_HEADINGS = ['Name', 'Receipt', 'Action'] as const;
const SEPARATOR = ' | ';
/** Border plus one cell of padding on each side, as for every popup. */
const FRAME = 4;
const MAX_OUTER_WIDTH = 96;
const MIN_NAME = 4;
const graphemes = new Intl.Segmenter();

/**
 * Shorter action labels for narrow terminals. Each stays distinct: "Not asked"
 * (no response was requested) must never read like "No action" (the agent decided).
 */
const SHORT_ACTIONS: Record<string, string> = {
    'No response requested': 'Not asked',
    'No action needed': 'No action',
    'Done · answer linked': 'Done · linked',
    'Done · recovered': 'Recovered',
    'Answer saved · posting pending': 'Posting',
    'Replied · continuing': 'Continuing',
    'Delivery unconfirmed': 'Unconfirmed',
    'Execution interrupted': 'Interrupted',
    'Answer posting failed': 'Post failed',
};

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Local time, as short as the date allows: time alone today, month and day this
 * year, the full date before that. The value is never shortened into a wrong one.
 */
export function compactTimestamp(at: number, now: number, precision: Precision = 'seconds'): string {
    const date = new Date(at);
    const today = new Date(now);
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}${precision === 'seconds' ? `:${pad(date.getSeconds())}` : ''}`;
    if (date.toDateString() === today.toDateString()) {
        return time;
    }
    if (date.getFullYear() === today.getFullYear()) {
        return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
    }
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** Control characters out, line breaks folded into spaces: a cell is one line. */
function cell(text: string): string {
    return stripVTControlCharacters(text).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
}

function receiptText(receipt: ReceiptCell, now: number, precision: Precision): string {
    if (receipt.kind === 'unconfirmed') {
        return 'Unconfirmed';
    }
    const at = compactTimestamp(receipt.at, now, precision);
    return receipt.kind === 'read' ? `Read ${at}` : at;
}

/** Cuts to `width` display cells by grapheme, ending in "…" when anything was removed. */
export function clip(text: string, width: number, measure: (text: string) => number): string {
    if (measure(text) <= width) {
        return text;
    }
    let kept = '';
    for (const {segment} of graphemes.segment(text)) {
        if (measure(kept + segment + '…') > width) {
            break;
        }
        kept += segment;
    }
    return width > 0 ? kept + '…' : '';
}

function padTo(text: string, width: number, measure: (text: string) => number): string {
    return text + ' '.repeat(Math.max(0, width - measure(text)));
}

type Columns = {name: number; receipt: number; action: number};

function natural(cells: string[][], measure: (text: string) => number): Columns {
    const widest = (column: number) => Math.max(...cells.map((row) => measure(row[column]!)));
    return {name: widest(0), receipt: widest(1), action: widest(2)};
}

const total = (columns: Columns) => columns.name + columns.receipt + columns.action + SEPARATOR.length * 2;

export function statusTable(rows: StatusRow[], bounds: TableBounds): PopupLayout {
    const {measure} = bounds;
    const now = bounds.now ?? Date.now();
    const maxOuter = Math.max(FRAME + 1, Math.min(MAX_OUTER_WIDTH, bounds.columns - 2));
    const available = maxOuter - FRAME;
    const maxHeight = Math.max(1, Math.min(12, Math.floor(bounds.rows / 2), bounds.rows - 3));

    const build = (precision: Precision, shortActions: boolean, reasons: boolean, narrow = false) => [
        [...(narrow ? NARROW_HEADINGS : HEADINGS)],
        ...rows.map((row) => {
            const action = cell(shortActions ? SHORT_ACTIONS[row.action] ?? row.action : row.action);
            const reason = row.reason ? cell(row.reason) : '';
            return [cell(row.name), receiptText(row.receipt, now, precision), reasons && reason ? `${action} — ${reason}` : action];
        }),
    ];

    // Narrow in a fixed order, each step only if still too wide: clip reasons first,
    // then drop seconds, then use short action labels, and only then cut names and actions.
    let cells = build('seconds', false, true);
    let columns = natural(cells, measure);
    if (total(columns) > available) {
        const withoutReasons = natural(build('seconds', false, false), measure);
        const reasonRoom = available - total({...withoutReasons, action: 0});
        if (reasonRoom >= withoutReasons.action) {
            columns = {...withoutReasons, action: reasonRoom};
        } else {
            for (const [precision, shortActions, narrow] of [['seconds', false, false], ['minutes', false, false], ['minutes', true, false], ['minutes', true, true]] as const) {
                cells = build(precision, shortActions, false, narrow);
                columns = natural(cells, measure);
                if (total(columns) <= available) {
                    break;
                }
            }
        }
    }
    if (total(columns) > available) {
        // Names give up width first, down to a floor, then actions; receipts are already short.
        const overflow = total(columns) - available;
        const fromName = Math.min(overflow, Math.max(0, columns.name - MIN_NAME));
        columns = {...columns, name: columns.name - fromName, action: Math.max(1, columns.action - (overflow - fromName))};
    }

    const line = (row: string[]) => [padTo(clip(row[0]!, columns.name, measure), columns.name, measure), padTo(clip(row[1]!, columns.receipt, measure), columns.receipt, measure), clip(row[2]!, columns.action, measure)].join(SEPARATOR).trimEnd();
    const lines = rows.length ? cells.map(line) : [line(cells[0]!), clip('No participant receipt yet', available, measure)];
    const width = Math.min(maxOuter, Math.max(...lines.map(measure)) + FRAME);
    const scrollable = lines.length + 2 > maxHeight;
    return {width, height: Math.min(maxHeight, lines.length + 2), content: lines.join('\n'), scrollable};
}

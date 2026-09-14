//! Small interactive pickers built on raw keypresses.
//!
//! These take temporary ownership of stdin, so a caller that already holds a
//! readline interface must pause it first and redraw afterwards. Everything
//! redraws in place rather than scrolling, and every picker can be abandoned
//! with Escape — returning `undefined`, which callers must distinguish from a
//! deliberate `null` meaning "never".

import {emitKeypressEvents} from 'node:readline';

import {describeDuration, formatDuration, parseDuration} from './when.js';

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const INVERT = '\u001b[7m';
const RESET = '\u001b[0m';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

export interface Key {
    name?: string;
    sequence?: string;
    ctrl?: boolean;
}

/** Runs `frame` with raw keypresses, restoring stdin however it ends. */
async function withKeys<T>(render: () => string, handle: (key: Key, resolve: (value: T) => void) => void): Promise<T> {
    const {stdin, stdout} = process;
    const wasRaw = stdin.isRaw === true;
    emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdout.write(HIDE_CURSOR);

    let lines = 0;
    const draw = () => {
        if (lines > 0) stdout.write(`\u001b[${lines}A`);
        const frame = render();
        stdout.write(frame.split('\n').map((line) => `\u001b[2K${line}`).join('\n') + '\n');
        lines = frame.split('\n').length;
    };
    draw();

    return new Promise<T>((resolve) => {
        const onKey = (_: string, key: Key) => {
            handle(key, (value) => {
                stdin.off('keypress', onKey);
                if (stdin.isTTY && !wasRaw) stdin.setRawMode(false);
                stdout.write(SHOW_CURSOR);
                resolve(value);
            });
            draw();
        };
        stdin.on('keypress', onKey);
    });
}

export interface MenuOption<T> {
    label: string;
    hint?: string;
    value: T;
}

/** A vertical menu. Returns undefined if the picker was abandoned. */
export async function chooseFromMenu<T>(title: string, options: MenuOption<T>[], startIndex = 0): Promise<T | undefined> {
    let index = startIndex;
    const render = () => {
        const rows = options.map((option, position) => {
            const marker = position === index ? `${INVERT} ` : '  ';
            const label = position === index ? `${option.label}${RESET}` : option.label;
            const hint = option.hint ? `  ${DIM}${option.hint}${RESET}` : '';
            return `${marker}${label}${position === index ? RESET : ''}${hint}`;
        });
        return [`${BOLD}${title}${RESET}`, '', ...rows, '', `${DIM}up/down to move · enter to choose · esc to cancel${RESET}`].join('\n');
    };
    return withKeys<T | undefined>(render, (key, resolve) => {
        if (key.name === 'up' || key.name === 'k') index = (index - 1 + options.length) % options.length;
        else if (key.name === 'down' || key.name === 'j') index = (index + 1) % options.length;
        else if (key.name === 'return' || key.name === 'space') resolve(options[index]!.value);
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) resolve(undefined);
    });
}

const FIELDS = [
    {label: 'year',   width: 4},
    {label: 'month',  width: 2},
    {label: 'day',    width: 2},
    {label: 'hour',   width: 2},
    {label: 'minute', width: 2},
] as const;

function daysInMonth(year: number, month: number): number {
    return new Date(year, month + 1, 0).getDate();
}

/**
 * A date and time editor. Left and right move between fields; up and down
 * change the one under the cursor.
 *
 * Day is clamped to the month's length whenever month or year changes, so
 * stepping off the 31st into February lands on a real date instead of silently
 * rolling into March.
 */
export async function pickDateTime(initial: Date, title = 'Expires at'): Promise<Date | undefined> {
    let field = 2;
    const parts = {year: initial.getFullYear(), month: initial.getMonth(), day: initial.getDate(), hour: initial.getHours(), minute: initial.getMinutes()};

    const clampDay = () => {
        parts.day = Math.min(parts.day, daysInMonth(parts.year, parts.month));
    };

    const adjust = (delta: number) => {
        switch (FIELDS[field]!.label) {
            case 'year':   parts.year += delta; clampDay(); break;
            case 'month':  parts.month = (parts.month + delta + 12) % 12; clampDay(); break;
            case 'day':    parts.day = wrap(parts.day + delta, 1, daysInMonth(parts.year, parts.month)); break;
            case 'hour':   parts.hour = wrap(parts.hour + delta, 0, 23); break;
            case 'minute': parts.minute = wrap(parts.minute + delta, 0, 59); break;
        }
    };

    const render = () => {
        const values = [pad(parts.year, 4), pad(parts.month + 1, 2), pad(parts.day, 2), pad(parts.hour, 2), pad(parts.minute, 2)];
        const shown = values.map((value, position) => (position === field ? `${INVERT}${value}${RESET}` : value));
        const stamp = `  ${shown[0]}-${shown[1]}-${shown[2]}   ${shown[3]}:${shown[4]}`;
        const chosen = new Date(parts.year, parts.month, parts.day, parts.hour, parts.minute);
        const relative = chosen.getTime() <= Date.now() ? `${DIM}that time has already passed${RESET}` : `${DIM}${describeDuration(chosen.getTime() - Date.now())} from now${RESET}`;
        return [
            `${BOLD}${title}${RESET}`,
            '',
            stamp,
            `  ${DIM}editing ${FIELDS[field]!.label}${RESET}`,
            '',
            `  ${relative}`,
            '',
            `${DIM}left/right to move · up/down to change · enter to confirm · esc to cancel${RESET}`,
        ].join('\n');
    };

    return withKeys<Date | undefined>(render, (key, resolve) => {
        if (key.name === 'left' || key.name === 'h') field = (field - 1 + FIELDS.length) % FIELDS.length;
        else if (key.name === 'right' || key.name === 'l' || key.name === 'tab') field = (field + 1) % FIELDS.length;
        else if (key.name === 'up' || key.name === 'k') adjust(1);
        else if (key.name === 'down' || key.name === 'j') adjust(-1);
        else if (key.name === 'pageup') adjust(10);
        else if (key.name === 'pagedown') adjust(-10);
        else if (key.name === 'return') resolve(new Date(parts.year, parts.month, parts.day, parts.hour, parts.minute));
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) resolve(undefined);
    });
}

/** Reads a line of text with raw keypresses, so it composes with the pickers. */
export async function promptLine(title: string, placeholder: string): Promise<string | undefined> {
    let text = '';
    const render = () => [
        `${BOLD}${title}${RESET}`,
        '',
        `  ${text.length > 0 ? text : `${DIM}${placeholder}${RESET}`}`,
        '',
        `${DIM}enter to confirm · esc to cancel${RESET}`,
    ].join('\n');

    return withKeys<string | undefined>(render, (key, resolve) => {
        if (key.name === 'return') resolve(text.trim().length > 0 ? text.trim() : undefined);
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) resolve(undefined);
        else if (key.name === 'backspace') text = text.slice(0, -1);
        else if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ') text += key.sequence;
    });
}

const RELATIVE_CHOICES = [1, 6, 12, 24, 72, 168].map((hours) => ({label: `In ${formatDuration(hours * 3_600_000)}`, value: hours * 3_600_000}));

/**
 * The whole expiry flow. Returns a timestamp, `null` for never, or `undefined`
 * if the person backed out — three outcomes a caller must keep distinct.
 */
export async function pickExpiry(roomName: string, current: number | null): Promise<number | null | undefined> {
    const now = Date.now();
    const currently = current === null ? 'never expires' : `expires ${new Date(current).toLocaleString()}`;

    const mode = await chooseFromMenu<'never' | 'relative' | 'absolute' | 'cancel'>(`Expiry for ${roomName}${DIM} — currently ${currently}${RESET}`, [
        {label: 'Never expires', value: 'never'},
        {label: 'In a while…', hint: 'pick a duration', value: 'relative'},
        {label: 'At a date and time…', hint: 'arrows to adjust', value: 'absolute'},
        {label: 'Cancel', value: 'cancel'},
    ], current === null ? 0 : 1);

    if (mode === undefined || mode === 'cancel') return undefined;
    if (mode === 'never') return null;

    if (mode === 'relative') {
        const chosen = await chooseFromMenu<number | 'custom' | 'back'>('Expires in', [
            ...RELATIVE_CHOICES,
            {label: 'Custom…', hint: 'e.g. 90m, 3 days', value: 'custom'},
            {label: 'Back', value: 'back'},
        ]);
        if (chosen === undefined || chosen === 'back') return undefined;
        if (chosen !== 'custom') return now + chosen;

        const typed = await promptLine('Expires in', '10 hours');
        if (typed === undefined) return undefined;
        return now + parseDuration(typed);
    }

    const start = current !== null && current > now ? new Date(current) : new Date(now + 86_400_000);
    const picked = await pickDateTime(start);
    return picked === undefined ? undefined : picked.getTime();
}

function wrap(value: number, low: number, high: number): number {
    const span = high - low + 1;
    return ((value - low) % span + span) % span + low;
}

function pad(value: number, width: number): string {
    return String(value).padStart(width, '0');
}

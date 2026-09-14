//! Parsing the ways a person says when something should end.
//!
//! Deliberately forgiving about phrasing and strict about meaning: a spec that
//! cannot be understood is rejected rather than guessed at, because guessing
//! wrong here silently ends someone's room at the wrong time.

const UNITS: {names: string[]; ms: number}[] = [
    {names: ['s', 'sec', 'secs', 'second', 'seconds'], ms: 1000},
    {names: ['m', 'min', 'mins', 'minute', 'minutes'], ms: 60_000},
    {names: ['h', 'hr', 'hrs', 'hour', 'hours'],       ms: 3_600_000},
    {names: ['d', 'day', 'days'],                      ms: 86_400_000},
    {names: ['w', 'week', 'weeks'],                    ms: 604_800_000},
    {names: ['mo', 'month', 'months'],                 ms: 2_592_000_000},
    {names: ['y', 'year', 'years'],                    ms: 31_536_000_000},
];

const NEVER = ['never', 'none', 'off', 'no', 'permanent', 'forever'];

export class WhenError extends Error {}

/** Parses a duration like `10 hours`, `2d`, or `90m` into milliseconds. */
export function parseDuration(input: string): number {
    const text = input.trim().toLowerCase().replace(/^in\s+/, '');
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(text);
    if (!match) throw new WhenError(`could not read "${input}" as a duration; try "10 hours", "2d", or "90m"`);
    const amount = Number(match[1]);
    const unit = UNITS.find((candidate) => candidate.names.includes(match[2]!));
    if (!unit) throw new WhenError(`"${match[2]}" is not a unit I know; use seconds, minutes, hours, days, weeks, months, or years`);
    if (amount <= 0) throw new WhenError('a duration has to be greater than zero');
    return amount * unit.ms;
}

/**
 * Parses an expiry spec into an absolute timestamp, or null for "never".
 *
 * Accepts `never`, `in 10 hours`, `10h`, `at 2026-09-20 18:00`, and a bare
 * date or date-time. A bare date means the start of that day, so "expires
 * 2026-09-20" does not quietly mean some arbitrary time on the 20th.
 */
export function parseExpiry(input: string, now = Date.now()): number | null {
    const text = input.trim();
    if (text.length === 0) throw new WhenError('say when: "never", "in 10 hours", or "at 2026-09-20 18:00"');
    if (NEVER.includes(text.toLowerCase())) return null;

    const relative = /^in\s+/i.test(text) || /^\d+(\.\d+)?\s*[a-z]+$/i.test(text);
    if (relative) return now + parseDuration(text);

    const absolute = text.replace(/^at\s+/i, '').replace(/^on\s+/i, '');
    const parsed = parseAbsolute(absolute);
    if (parsed === null) throw new WhenError(`could not read "${input}" as a time; try "in 10 hours", "at 2026-09-20 18:00", or "never"`);
    return parsed;
}

function parseAbsolute(text: string): number | null {
    // A bare date is local midnight, not UTC midnight, so the day means the
    // reader's day rather than one shifted by their offset.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();

    const dateTime = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
    if (dateTime) return new Date(Number(dateTime[1]), Number(dateTime[2]) - 1, Number(dateTime[3]), Number(dateTime[4]), Number(dateTime[5]), Number(dateTime[6] ?? 0)).getTime();

    const fallback = Date.parse(text);
    return Number.isNaN(fallback) ? null : fallback;
}

/**
 * A rough, readable duration for display: largest sensible unit, rounded.
 * `formatDuration` stays exact because settings round-trip through it, and an
 * approximation there would quietly change what someone configured.
 */
export function describeDuration(ms: number): string {
    for (const unit of [...UNITS].reverse()) {
        if (ms >= unit.ms) {
            const amount = Math.round((ms / unit.ms) * 10) / 10;
            const name = unit.names.at(-1)!;
            return `${amount} ${amount === 1 ? name.replace(/s$/, '') : name}`;
        }
    }
    return 'less than a second';
}

/** Formats a duration in milliseconds the way someone would say it. */
export function formatDuration(ms: number): string {
    for (const unit of [...UNITS].reverse()) {
        if (ms >= unit.ms && ms % unit.ms === 0) {
            const amount = ms / unit.ms;
            const name = unit.names.at(-1)!;
            return `${amount} ${amount === 1 ? name.replace(/s$/, '') : name}`;
        }
    }
    return `${Math.round(ms / 1000)} seconds`;
}

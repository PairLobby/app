//! `@name` completion for the room composer.
//!
//! Kept apart from the chat loop so the matching rules can be tested without a
//! terminal: getting "who does @c mean" wrong sends a message to the wrong
//! participant, which is worse than not offering completion at all.

const ACCENT = '\u001b[1m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

/** The partial name being typed, or null when the cursor is not in a mention. */
export function currentMention(line: string, cursor = line.length): string | null {
    const before = line.slice(0, cursor);
    // A mention starts at the beginning or after whitespace, so an email address
    // or a path containing @ never opens the completer.
    const match = /(?:^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(before);
    return match ? match[1]! : null;
}

/**
 * Names matching a partial, case-insensitively, prefix first.
 *
 * An exact match still lists its rivals: two participants may share a display
 * name, and silently picking one of them is the failure this avoids.
 */
export function matchNames(partial: string, names: string[]): string[] {
    const wanted = partial.toLowerCase();
    if (wanted.length === 0) {
        return [...names];
    }
    const prefix = names.filter((name) => name.toLowerCase().startsWith(wanted));
    const contains = names.filter((name) => !name.toLowerCase().startsWith(wanted) && name.toLowerCase().includes(wanted));
    return [...prefix, ...contains];
}

/** The longest prefix every match shares, so Tab advances without choosing. */
export function commonPrefix(names: string[]): string {
    if (names.length === 0) {
        return '';
    }
    let prefix = names[0]!;
    for (const name of names.slice(1)) {
        let index = 0;
        while (index < prefix.length && index < name.length && prefix[index]!.toLowerCase() === name[index]!.toLowerCase()) index += 1;
        prefix = prefix.slice(0, index);
    }
    return prefix;
}

/** Replaces the partial under the cursor with `name`, returning the new line. */
export function applyMention(line: string, name: string, cursor = line.length): string {
    const before = line.slice(0, cursor);
    const match = /@([\p{L}\p{N}_.-]*)$/u.exec(before);
    if (!match) {
        return line;
    }
    const start = before.length - match[1]!.length;
    return `${line.slice(0, start)}${name}${line.slice(cursor)}`;
}

/** One rendered suggestion line: the typed part lit, the rest quiet. */
export function renderSuggestions(partial: string, matches: string[], width = 80): string {
    if (matches.length === 0) {
        return `${DIM}  no participant matches @${partial}${RESET}`;
    }
    const shown = matches.slice(0, 6).map((name) => {
        const at = name.toLowerCase().indexOf(partial.toLowerCase());
        if (partial.length === 0 || at === -1) {
            return `${DIM}${name}${RESET}`;
        }
        // Empty runs would emit colour codes around nothing, which shows up in
        // any transcript of the terminal and reads as noise.
        const quiet = (text: string) => (text.length > 0 ? `${DIM}${text}${RESET}` : '');
        return `${quiet(name.slice(0, at))}${ACCENT}${name.slice(at, at + partial.length)}${RESET}${quiet(name.slice(at + partial.length))}`;
    });
    const more = matches.length > shown.length ? `${DIM} +${matches.length - shown.length} more${RESET}` : '';
    const hint = matches.length === 1 ? `${DIM}  tab to complete${RESET}` : '';
    const line = `  ${shown.join('  ')}${more}${hint}`;
    return truncateVisible(line, width);
}

const ANSI = /\u001b\[[0-9;]*m/g;

function visibleLength(text: string): number {
    return text.replace(ANSI, '').length;
}

/**
 * Cuts to a visible width while keeping escape sequences whole. Slicing the raw
 * string would cut one in half and leave the rest of the terminal wearing
 * whatever colour was half-applied.
 */
function truncateVisible(text: string, width: number): string {
    if (visibleLength(text) <= width) {
        return text;
    }
    let out = '';
    let visible = 0;
    let index = 0;
    while (index < text.length && visible < width) {
        ANSI.lastIndex = index;
        const match = new RegExp(ANSI.source, 'y').exec(text.slice(index));
        if (match && match.index === 0) {
            out += match[0];
            index += match[0].length;
            continue;
        }
        out += text[index];
        index += 1;
        visible += 1;
    }
    return `${out}${RESET}`;
}

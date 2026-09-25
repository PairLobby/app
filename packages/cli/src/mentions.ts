//! `@name` completion for the room composer.
//!
//! Kept apart from the chat loop so the matching rules can be tested without a
//! terminal: getting "who does @c mean" wrong sends a message to the wrong
//! participant, which is worse than not offering completion at all.

const ACCENT = '\u001b[1m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

type MentionParticipant = {participantId: string; displayName: string; revoked: boolean; left: boolean};
export type RoutedChatMessage = {text: string; recipientId: string | null; recipientIds?: string[]; allRecipients?: boolean};

const MENTION = /(?:^|[\s,])@("(?:\\.|[^"\\])*"|[\p{L}\p{N}_.-]+)/gu;
const PARTIAL_MENTION = /@("(?:\\.|[^"\\])*|[\p{L}\p{N}_.-]*)$/u;

/** Resolve explicit mentions anywhere in a message without silently broadcasting typos. */
export function routeChatMessage(text: string, participants: MentionParticipant[], fallbackRecipientId: string | null = null): RoutedChatMessage {
    const matches = [...text.matchAll(MENTION)];
    const remainder = text.replace(MENTION, '');
    if (/(?:^|[\s,])@"/u.test(remainder)) {
        throw new Error('Close the quoted participant name before sending. Message not sent.');
    }
    const references = matches.map((match) => {
        const raw = match[1]!;
        if (!raw.startsWith('"')) {
            return raw;
        }
        try {
            return JSON.parse(raw) as string;
        } catch {
            throw new Error('Invalid quoted participant name. Message not sent.');
        }
    });
    const active = participants.filter((participant) => !participant.revoked && !participant.left);
    const recipients = new Set<string>();
    let allRecipients = false;
    for (const reference of references) {
        if (reference.replace(/\.+$/, '').toLowerCase() === 'all') {
            allRecipients = true;
            continue;
        }
        let matches = active.filter((participant) => participant.participantId === reference || participant.displayName.toLowerCase() === reference.toLowerCase());
        // Sentence punctuation is not part of a name unless an exact name exists.
        if (matches.length === 0 && reference.endsWith('.')) {
            const name = reference.replace(/\.+$/, '');
            matches = active.filter((participant) => participant.displayName.toLowerCase() === name.toLowerCase());
        }
        if (matches.length === 0) {
            throw new Error(`Nobody here is called @${reference}. Message not sent.`);
        }
        if (matches.length > 1) {
            throw new Error(`Several participants are called @${reference}; mention their participant ID instead. Message not sent.`);
        }
        recipients.add(matches[0]!.participantId);
    }
    if (references.length && !remainder.replace(/[\s,!:;.?]/g, '')) {
        throw new Error('Add a message alongside the mention.');
    }
    if (allRecipients) {
        return {text, recipientId: null, allRecipients: true};
    }
    if (recipients.size > 1) {
        return {text, recipientId: null, recipientIds: [...recipients]};
    }
    const recipientId = recipients.values().next().value ?? fallbackRecipientId;
    return recipientId ? {text, recipientId} : {text, recipientId: null, allRecipients: true};
}

/** The partial name being typed, or null when the cursor is not in a mention. */
export function currentMention(line: string, cursor = line.length): string | null {
    const before = line.slice(0, cursor);
    // A mention starts at the beginning or after whitespace, so an email address
    // or a path containing @ never opens the completer.
    const match = new RegExp(`(?:^|[\\s,])${PARTIAL_MENTION.source}`, 'u').exec(before);
    if (!match) {
        return null;
    }
    const raw = match[1]!;
    if (raw.startsWith('"')) {
        try {
            return JSON.parse(`${raw}"`) as string;
        } catch {
            return null;
        }
    }
    return raw;
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
    const match = PARTIAL_MENTION.exec(before);
    if (!match) {
        return line;
    }
    const start = before.length - match[1]!.length;
    const complete = name.endsWith(' ');
    const label = complete ? name.slice(0, -1) : name;
    const quoted = /[^\p{L}\p{N}_.-]/u.test(label) || match[1]!.startsWith('"');
    const replacement = quoted ? (complete ? `${JSON.stringify(label)} ` : JSON.stringify(label).slice(0, -1)) : name;
    return `${line.slice(0, start)}${replacement}${line.slice(cursor)}`;
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

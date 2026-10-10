import {completeAgentCommand} from './spawn-options.js';
import {commonPrefix, renderSuggestions} from './mentions.js';

export const CHAT_COMMANDS = ['/claude', '/codex', '/qwen', '/spawn', '/agents', '/agent', '/status', '/settings', '/turns', '/to', '/seen', '/collapse', '/expand', '/working', '/select', '/requests', '/reply', '/who', '/name', '/invite', '/invites', '/lock', '/unlock', '/kick', '/mute', '/unmute', '/expiry', '/interrupt', '/pause', '/resume', '/help', '/quit', '/exit'];
const SUBCOMMANDS: Record<string, string[]> = {
    '/agent': ['start', 'stop'],
    '/turns': ['sequential', 'parallel', 'skip', 'cancel'],
    '/requests': ['retry', 'reassign', 'dismiss', 'cancel'],
    '/invite': ['as', 'member', 'observer'],
    '/invites': ['revoke']
};

/** Readline supplies the text before the cursor; it preserves the suffix itself. */
export function commandMatches(line: string): string[] | null {
    if (!line.startsWith('/')) {
        return null;
    }
    if (/^\/\S*$/.test(line)) {
        return CHAT_COMMANDS.filter((command) => command.startsWith(line)).map((command) => command + ' ');
    }
    const match = /^(\/\w+) (\S*)$/.exec(line);
    if (match && SUBCOMMANDS[match[1]!]) {
        return SUBCOMMANDS[match[1]!]!.filter((word) => word.startsWith(match[2]!)).map((word) => `${match[1]} ${word} `);
    }
    return completeAgentCommand(line);
}

/** A single prefix avoids readline's invisible multi-column menu in SilentOutput. */
export function completeChatCommand(line: string): [string[], string] | null {
    const matches = commandMatches(line);
    if (matches === null) {
        return null;
    }
    const advance = matches.length === 1 ? matches[0]! : commonPrefix(matches);
    return [advance.length > line.length ? [advance] : [], line];
}

export function commandHint(line: string, cursor = line.length, width = 80): string | null {
    const before = line.slice(0, cursor);
    const matches = commandMatches(before);
    if (matches === null || (matches.length === 0 && /\s/.test(before))) {
        return null;
    }
    if (!matches.length) {
        return `No command matches ${before}; /help lists commands`.slice(0, Math.max(0, width));
    }
    return renderSuggestions(before, matches.map((match) => match.trimEnd()), width);
}

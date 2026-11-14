//! Offline reference lookup. This module never reads the device registry or contacts a relay.

import {FEATURES, SECTIONS, SCOPE_LABELS, STATUS_LABELS, searchDocumentation} from './docs/catalog.js';
import type {Block, CommandEntry, DocSection, Feature} from './docs/catalog.js';

export type DocumentationOptions = {topic?: string; search?: string; all?: boolean; version: string; context?: 'shell' | 'room'};
export type DocumentationTopic = {id: string; title: string};
export type DocumentationResult = {version: string; kind: 'index' | 'topic' | 'search' | 'all'; topics: DocumentationTopic[]; features: Feature[]; commands: CommandEntry[]; sections: DocSection[]; markdown: string};

export const DOCS_HELP = 'pairlobby docs [topic] [--json]\npairlobby docs --search <words> [--json]\npairlobby docs --all [--json]\n\nFull reference bundled with this CLI. No account, room, relay or internet connection is needed.';

const ALIASES: Record<string, string> = {
    start: 'quick-start', files: 'files', agents: 'integrations', receiving: 'integrations', manual: 'integrations',
    settings: 'device-settings', recovery: 'request-recovery', requests: 'request-recovery',
    network: 'relays', relay: 'relays', backup: 'relays', backups: 'relays', tokens: 'team-relays',
    directory: 'directory', accounts: 'hosted', account: 'hosted', types: 'room-types', permissions: 'permissions-presets', presets: 'permissions-presets',
    commands: 'shell-commands', chat: 'room-commands', keys: 'keys', move: 'room-types', limits: 'relays', api: 'protocol', compatibility: 'protocol'
};

function commandText(entry: CommandEntry): string {
    return [`### ${entry.syntax}`, entry.summary, ...(entry.access ? [`Access: ${entry.access}.`] : []), ...(entry.details ?? []), ...(entry.example ? [`\`\`\`sh\n${entry.example}\n\`\`\``] : [])].join('\n\n');
}

function blockText(block: Block): string {
    switch (block.kind) {
        case 'p': return block.text;
        case 'h3': return `### ${block.text}`;
        case 'note': return `${block.tone === 'caution' ? 'Limit' : 'Note'}: ${block.text}`;
        case 'example': return `${block.label} (${SCOPE_LABELS[block.scope]})\n\n\`\`\`\n${block.code}\n\`\`\``;
        case 'list': return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${item.text}`).join('\n');
        case 'table': return [block.caption, '', `| ${block.head.join(' | ')} |`, `| ${block.head.map(() => '---').join(' | ')} |`, ...block.rows.map((row) => `| ${row.cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`)].join('\n');
        case 'features': return FEATURES.map((feature) => `- **${feature.title}** (${STATUS_LABELS[feature.status]}): ${feature.text}`).join('\n');
        case 'finder': return 'Use pairlobby docs --search <words> to find commands, features and reference topics.';
    }
}

function sectionText(section: DocSection): string {
    return [`## ${section.title}`, ...section.blocks.map(blockText), ...(section.groups ?? []).flatMap((group) => [`### ${group.title} (${SCOPE_LABELS[group.scope]})`, ...(group.intro ? [group.intro] : []), ...group.entries.map(commandText)])].join('\n\n');
}

/** A focused local lookup into the existing website section, without moving its public anchors. */
function fileTopic(): DocSection {
    const integration = SECTIONS.find((section) => section.id === 'integrations')!;
    return {id: 'files', title: 'Files, retention and export', nav: 'Files', blocks: integration.blocks.filter((block) => block.id.startsWith('files') || block.id.startsWith('file-') || block.id.startsWith('export') || block.id === 'managed-file-retention')};
}

export function documentation(options: DocumentationOptions): DocumentationResult {
    const topic = options.topic?.trim().toLowerCase();
    const query = options.search?.trim();
    if ([Boolean(topic), Boolean(query), options.all === true].filter(Boolean).length > 1) {
        throw new Error('Choose one topic, --search, or --all.');
    }
    const available = [...SECTIONS, fileTopic()];
    const topics = available.map(({id, title}) => ({id, title}));
    const header = `# PairLobby ${options.version} reference\n\nThis reference ships with this CLI. Relay features depend on the deployment; pairlobby doctor reports what the selected relay supports.\n`;
    if (query) {
        const {commands, features, topics: matches} = searchDocumentation(query);
        const found = commands.length + features.length + matches.length;
        const markdown = [header, `Search: ${query}`, found ? `${commands.length} commands, ${features.length} features, ${matches.length} topics.` : 'No matches. Run pairlobby docs for available topics.', ...commands.map(commandText), ...features.map((feature) => `- ${feature.title} (${STATUS_LABELS[feature.status]}): ${feature.text}`), ...(matches.length ? ['Related topics:', ...matches.map((section) => `- ${section.id}: ${section.title}`)] : [])].join('\n\n');
        return {version: options.version, kind: 'search', topics: matches, features, commands, sections: [], markdown};
    }
    if (topic || options.all) {
        const id = topic ? ALIASES[topic] ?? topic : undefined;
        const sections = options.all ? SECTIONS : available.filter((section) => section.id === id);
        if (!sections.length) {
            throw new Error(`Unknown documentation topic: ${options.topic}. Run pairlobby docs, or pairlobby docs --search "${options.topic}".`);
        }
        return {version: options.version, kind: options.all ? 'all' : 'topic', topics, features: options.all || id === 'features' ? FEATURES : [], commands: [], sections, markdown: [header, ...sections.map(sectionText)].join('\n\n')};
    }
    const entry = options.context === 'room' ? '/docs' : 'pairlobby docs';
    const markdown = [header, 'Choose a topic:', ...topics.map(({id, title}) => `  ${id.padEnd(22)} ${title}`), '', `${entry} files                  File transfer and retention`, `${entry} --search "file receipt"   Search commands and guidance`, `${entry} --all                  Full offline manual`, 'Add --json from the shell for structured reference data.'].join('\n');
    return {version: options.version, kind: 'index', topics, features: FEATURES, commands: [], sections: [], markdown};
}

export function chatDocumentation(argument: string, version: string): string {
    const value = argument.trim();
    if (value === '--all' || value === 'all') {
        return documentation({version, all: true, context: 'room'}).markdown;
    }
    if (value.startsWith('--search ') || value.startsWith('search ')) {
        const query = value.replace(/^(?:--)?search\s+/, '').replace(/^(['"])(.*)\1$/, '$2');
        return documentation({version, search: query, context: 'room'}).markdown;
    }
    return documentation({version, ...(value ? {topic: value} : {}), context: 'room'}).markdown;
}

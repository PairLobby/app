#!/usr/bin/env node
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {COMMANDS, SECTIONS, catalogIds} from '../packages/cli/dist/docs/catalog.js';
import {commandInventory, defaultSettingText, managedTools, relayVariables, settingsInventory} from './docs-inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventory = commandInventory(root);
const syntax = COMMANDS.map((entry) => entry.syntax).join('\n');
const text = JSON.stringify({COMMANDS, SECTIONS});
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const missing = [];
const documentedFlags = new Set([...text.matchAll(/--([a-z][a-z0-9-]*)/g)].map((match) => match[1]));
for (const flag of inventory.flags) if (!documentedFlags.has(flag)) missing.push(`CLI flag --${flag}`);
for (const command of inventory.shell) {
    if (!new RegExp(`pairlobby\\s+${escape(command)}(?=\\s|$|\\|)`).test(syntax)) missing.push(`shell command ${command}`);
}
for (const command of inventory.chat) {
    if (!new RegExp(`${escape(command)}(?=\\s|$|\\|)`).test(syntax)) missing.push(`chat command ${command}`);
}
for (const variable of relayVariables(root)) if (!text.includes(variable)) missing.push(`relay variable ${variable}`);
for (const tool of managedTools(root)) if (!text.includes(`\`${tool}\``)) missing.push(`managed tool ${tool}`);
for (const section of SECTIONS) {
    for (const group of section.groups ?? []) {
        for (const entry of group.entries) {
            if (entry.syntax.startsWith('/') && group.scope !== 'room') missing.push(`room scope for ${entry.id}`);
            if (entry.syntax.startsWith('pairlobby') && group.scope !== 'shell') missing.push(`shell scope for ${entry.id}`);
        }
    }
}
const settingRows = SECTIONS.flatMap((section) => section.blocks).find((block) => block.kind === 'table' && block.id === 'device-settings-table')?.rows ?? [];
for (const setting of settingsInventory(root)) {
    const row = settingRows.find((candidate) => candidate.id === setting.key);
    if (!row || row.cells[0] !== `\`${setting.key}\`` || row.cells[1] !== defaultSettingText(setting) || !row.cells[2].includes(setting.help)) missing.push(`setting/default ${setting.key}`);
}
const ids = catalogIds();
if (new Set(ids).size !== ids.length) missing.push('unique documentation IDs');
if (missing.length) throw new Error(`Documentation coverage is incomplete:\n${missing.map((item) => `- ${item}`).join('\n')}`);
console.log(`Documentation covers ${inventory.shell.length} CLI commands, ${inventory.flags.length} flags, ${inventory.chat.length} chat commands/aliases, ${settingsInventory(root).length} settings, ${relayVariables(root).length} relay variables and ${managedTools(root).length} managed tools.`);

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {isSkillAgent, skillAgents, skillsDirectoryForAgent} from './skill-paths.js';
import type {SkillAgent} from './skill-paths.js';

export function installSkill(agent: string | undefined, force = false, skillsDirectory?: string): string[] {
    if (!agent || (agent !== 'all' && !isSkillAgent(agent))) {
        throw new Error('Usage: pairlobby install-skill claude|codex|qwen|cursor|grok|muse|all [--force] [--skills-dir <directory>]');
    }
    const candidates = [new URL('../skills/pairlobby/SKILL.md', import.meta.url), new URL('../../../integrations/claude-code/SKILL.md', import.meta.url)];
    const source = candidates.map((url) => fileURLToPath(url)).find(existsSync);
    if (!source) {
        throw new Error('This installation is missing its skill file. Reinstall the official PairLobby package.');
    }
    const content = readFileSync(source, 'utf8');
    const agents: readonly SkillAgent[] = agent === 'all' ? skillAgents : [agent];
    if (skillsDirectory && agent === 'all') {
        throw new Error('Choose one agent when using --skills-dir');
    }
    const destinations = agents.map((name) => join(skillsDirectory ? resolve(skillsDirectory) : skillsDirectoryForAgent(name), 'pairlobby', 'SKILL.md'));
    for (const destination of destinations)
        if (existsSync(destination) && readFileSync(destination, 'utf8') !== content && !force) {
            throw new Error(`A different skill already exists at ${destination}. Review it first; --force saves a backup and replaces it.`);
        }
    for (const destination of destinations) {
        mkdirSync(dirname(destination), {recursive: true, mode: 0o700});
        if (existsSync(destination) && readFileSync(destination, 'utf8') !== content) {
            writeFileSync(destination + `.backup-${Date.now()}`, readFileSync(destination), {mode: 0o600});
        }
        writeFileSync(destination, content, {mode: 0o600});
    }
    return destinations;
}

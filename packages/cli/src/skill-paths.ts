import {homedir} from 'node:os';
import {join} from 'node:path';

export const skillAgents = ['claude', 'codex', 'qwen', 'cursor', 'grok', 'muse'] as const;

export type SkillAgent = typeof skillAgents[number];

export function isSkillAgent(agent: string): agent is SkillAgent {
    return skillAgents.includes(agent as SkillAgent);
}

export function skillsDirectoryForAgent(agent: SkillAgent): string {
    switch (agent) {
        case 'codex':
            return join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'skills');
        case 'muse':
            return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'muse', 'skills');
        default:
            return join(homedir(), `.${agent}`, 'skills');
    }
}

import type {TurnEntry, TurnQueue} from '@pairlobby/protocol';

export type LogoProvider = 'claude' | 'openai' | 'qwen' | 'deepseek' | 'other';
export type WorkingGroup = {provider: LogoProvider; state: 'working' | 'provider_wait'; entries: TurnEntry[]; count: number};

export const PROVIDER_LABELS: Record<LogoProvider, string> = {claude: 'Claude', openai: 'OpenAI', qwen: 'Qwen', deepseek: 'DeepSeek', other: 'Agent'};

export function logoProvider(runtime?: string): LogoProvider {
    const normalized = runtime?.toLowerCase().replace(/-(cli|code)$/u, '');
    if (normalized === 'codex' || normalized === 'chatgpt' || normalized === 'openai') {
        return 'openai';
    }
    return normalized === 'claude' || normalized === 'qwen' || normalized === 'deepseek' ? normalized : 'other';
}

export class WorkingView {
    private entries: TurnEntry[] = [];

    update(queue: TurnQueue): void {
        this.entries = queue.entries;
    }

    active(now = Date.now()): TurnEntry[] {
        return this.entries.filter((entry) => entry.state === 'answering' && entry.workingAt !== undefined && (entry.expiresAt ?? 0) > now);
    }

    visible(now = Date.now()): TurnEntry[] {
        return [...this.active(now), ...this.entries.filter((entry) => entry.state === 'provider_wait')];
    }

    forMessage(eventId: string, now = Date.now()): TurnEntry[] {
        return this.visible(now).filter((entry) => entry.conversationId === eventId || entry.requestId === eventId);
    }

    groups(now = Date.now()): WorkingGroup[] {
        const groups = new Map<string, {provider: LogoProvider; state: 'working' | 'provider_wait'; entries: TurnEntry[]}>();
        for (const entry of this.visible(now)) {
            const provider = logoProvider(entry.runtime);
            const state = entry.state === 'provider_wait' ? 'provider_wait' : 'working';
            const key = `${provider}:${state}`;
            const group = groups.get(key) ?? {provider, state, entries: []};
            group.entries.push(entry);
            groups.set(key, group);
        }
        return [...groups.values()].map((group) => ({...group, count: new Set(group.entries.map((entry) => entry.participantId)).size}));
    }
}

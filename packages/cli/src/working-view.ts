import type {TurnEntry, TurnQueue} from '@pairlobby/protocol';

export type LogoProvider = 'claude' | 'openai' | 'qwen' | 'deepseek' | 'other';
export type WorkingGroup = {provider: LogoProvider; entries: TurnEntry[]; count: number};

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

    forMessage(eventId: string, now = Date.now()): TurnEntry[] {
        return this.active(now).filter((entry) => entry.conversationId === eventId || entry.requestId === eventId);
    }

    groups(now = Date.now()): WorkingGroup[] {
        const groups = new Map<LogoProvider, TurnEntry[]>();
        for (const entry of this.active(now)) {
            const provider = logoProvider(entry.runtime);
            const entries = groups.get(provider) ?? [];
            entries.push(entry);
            groups.set(provider, entries);
        }
        return [...groups].map(([provider, entries]) => ({provider, entries, count: new Set(entries.map((entry) => entry.participantId)).size}));
    }
}

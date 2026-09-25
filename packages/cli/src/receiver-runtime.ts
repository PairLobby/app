import type {MessageRequest} from '@pairlobby/protocol';

export type RuntimeOptions = {cwd: string; threadId?: string; model?: string; executable?: string; args?: string[]; roomId?: string; sessionId?: string};
export type RuntimeHooks = {acknowledge: () => Promise<void>; pass?: () => Promise<void>; started: (turnId: string) => void; usage: (value: unknown) => void};

export interface ReceiverRuntime {
    connect(): Promise<string>;
    execute(request: MessageRequest, hooks: RuntimeHooks): Promise<string>;
    close(): void;
}

export type ReceiverRuntimeName = 'codex' | 'claude' | 'qwen';

export function receiverRuntimeName(runtime?: string): ReceiverRuntimeName | null {
    if (runtime === 'codex' || runtime === 'codex-cli') {
        return 'codex';
    }
    if (runtime === 'claude' || runtime === 'claude-code') {
        return 'claude';
    }
    if (runtime === 'qwen' || runtime === 'qwen-code') {
        return 'qwen';
    }
    return null;
}

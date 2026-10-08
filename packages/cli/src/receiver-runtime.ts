import type {MessageRequest} from '@pairlobby/protocol';
import type {ManagedDeadlinePolicy, ManagedDeadlineSnapshot} from './managed-deadline.js';

export type RuntimeOptions = {cwd: string; threadId?: string; model?: string; effort?: string; executable?: string; args?: string[]; roomId?: string; sessionId?: string; deadline?: ManagedDeadlinePolicy};
export type RuntimeMessageStatus = 'waiting' | 'no_action' | 'declined';
export type RuntimeHooks = {acknowledge: () => Promise<void>; pass?: () => Promise<void>; working?: () => Promise<void>; messageStatus?: (state: RuntimeMessageStatus, reason: string) => Promise<void>; started: (turnId: string, processId?: number) => void; activity?: (snapshot: ManagedDeadlineSnapshot) => void; usage: (value: unknown) => void; model?: (model: string) => void};

/** What an interrupt really stopped; never more than the runtime confirmed. */
export type InterruptOutcome = 'current_turn_cancelled' | 'tool_cancellation_unknown' | 'paused_between_turns';

/** The turn ended because it was interrupted; its partial output must not be posted. */
export class RuntimeInterrupted extends Error {
    constructor() {
        super('Interrupted by a room owner or admin; no answer was posted.');
        this.name = 'RuntimeInterrupted';
    }
}

export interface ReceiverRuntime {
    readonly model?: string | undefined;
    readonly threadId: string;
    connect(): Promise<string>;
    execute(request: MessageRequest, hooks: RuntimeHooks): Promise<string>;
    /** Stops the running turn, if any, and resolves once the runtime confirms what stopped. */
    interrupt(): Promise<InterruptOutcome>;
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

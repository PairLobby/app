//! Working out which agent runtime is running this command, and which of its own
//! conversations this is.
//!
//! The point is to let a human find the agent again: a room participant is not
//! much use if you cannot work out which terminal to go and talk to. Everything
//! here is a hint read from the environment, never an authenticated fact.

export interface RuntimeIdentity {
    /** The runtime's own conversation or session identifier, when it publishes one. */
    conversationId?: string;
    /** The runtime name, as the runtime itself reports it. */
    runtime?: string;
    /** Terminal session, so a human can find the pane this agent is running in. */
    terminal?: string;
    /** The process that invoked the CLI. */
    pid: number;
}

/**
 * Environment variables known to carry a runtime's conversation id.
 *
 * Only Claude Code is verified — its variable was observed directly. The others
 * are plausible names probed opportunistically; if one is absent nothing is
 * claimed, and a runtime can always be told explicitly with --conversation.
 */
const CONVERSATION_VARIABLES: {variable: string; runtime: string; verified: boolean}[] = [
    {variable: 'CLAUDE_CODE_SESSION_ID', runtime: 'claude-code', verified: true},
    {variable: 'CODEX_SESSION_ID', runtime: 'codex-cli', verified: false},
    {variable: 'CODEX_THREAD_ID', runtime: 'codex-cli', verified: false},
    {variable: 'CODEX_CONVERSATION_ID', runtime: 'codex-cli', verified: false}
];

export function detectRuntime(): RuntimeIdentity {
    const found = CONVERSATION_VARIABLES.map((candidate) => ({...candidate, value: process.env[candidate.variable]})).find((candidate) => candidate.value);
    const terminal = process.env['TERM_SESSION_ID'] ?? process.env['ITERM_SESSION_ID'];
    return {
        ...(found ? {conversationId: found.value!, runtime: found.runtime} : {}),
        ...(terminal ? {terminal} : {}),
        pid: process.ppid
    };
}

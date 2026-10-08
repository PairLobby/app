import {parseArgs} from 'node:util';
import {ParticipantName} from '@pairlobby/protocol';
import {UsageError} from './context.js';
import {receiverRuntimeName} from './receiver-runtime.js';
import type {ReceiverRuntimeName} from './receiver-runtime.js';
import {parseManagedDuration} from './device-settings.js';
import {validateManagedDeadline} from './managed-deadline.js';

export type SpawnOptions = {runtime?: ReceiverRuntimeName; model?: string; name?: string; effort?: string; workdir?: string; taskIdleTimeoutMs?: number; taskTimeoutMs?: number; resume?: string; room?: string; session?: string; json?: boolean; help?: boolean};
export const SPAWN_HELP = `Spawn a local background agent in this room:
  /claude [model] [--name name] [--effort level] [--workdir directory] [--task-timeout 1h]
  /codex [model] [--name name] [--effort level] [--workdir directory] [--task-timeout 1h]
  /qwen [model] [--name name] [--workdir directory] [--task-timeout 1h]
  /spawn <claude|codex|qwen> [model] [options]
  /spawn --resume <operation-id>    recover an interrupted spawn
  /agents                         table of all room agents; double-click to copy
  /agent start|stop <name|id>      manage your own spawned receivers

Outside chat: pairlobby spawn <runtime> [model] [options] --room <room> [--session <human-session>] [--json]
Agent table: arrows/Tab move, PgUp/PgDn page, Enter/double-click copy, R refresh, Esc close.
Origin identifies This session, Other session, or Joined externally; private metadata may be unavailable.
Use --model instead of the positional model if preferred. Quote names/paths containing spaces.
Use --task-idle-timeout and --task-timeout to override this device's managed-request limits for one agent.
Codex effort is checked against its model catalog before inference. Claude requires a CLI with --effort support.
Qwen effort overrides are not supported by this adapter. Provider/model access is verified on the first task.
Agents wait without inference and survive closing chat. /turns parallel allows independent agents to work together.`;

/** Shell-like quoting only: no expansion, evaluation, or subprocess execution. */
export function splitCommand(line: string): string[] {
    const tokens: string[] = [];
    let word = '', quote = '', started = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index]!;
        if (char === '\\' && quote !== "'") {
            const next = line[index + 1];
            if (next === undefined) {
                throw new UsageError('Incomplete escape in command');
            }
            if (!quote || next === quote || next === '\\') {
                word += next;
                index++;
            } else {
                word += char;
            }
            started = true;
        } else if (quote) {
            if (char === quote) {
                quote = '';
            } else {
                word += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
            started = true;
        } else if (/\s/.test(char)) {
            if (started) {
                tokens.push(word);
                word = '';
                started = false;
            }
        } else {
            word += char;
            started = true;
        }
    }
    if (quote) {
        throw new UsageError('Unclosed quote in command');
    }
    if (started) {
        tokens.push(word);
    }
    return tokens;
}

export function parseSpawnOptions(args: string[], cli = false): SpawnOptions {
    const options = {model: {type: 'string'}, name: {type: 'string'}, effort: {type: 'string'}, workdir: {type: 'string'}, 'task-idle-timeout': {type: 'string'}, 'task-timeout': {type: 'string'}, resume: {type: 'string'}, help: {type: 'boolean'}, room: {type: 'string'}, session: {type: 'string'}, json: {type: 'boolean'}} as const;
    const {values, positionals, tokens} = parseArgs({args, options, allowPositionals: true, tokens: true, strict: true});
    const seen = new Set<string>();
    for (const token of tokens) {
        if (token.kind === 'option') {
            if (!cli && ['room', 'session', 'json'].includes(token.name)) {
                throw new UsageError('Room and identity are supplied by the current chat; use those options only on the CLI.');
            }
            if (seen.has(token.name)) {
                throw new UsageError(`Duplicate option --${token.name}`);
            }
            seen.add(token.name);
        }
    }
    if (values.help) {
        return {help: true};
    }
    const result: SpawnOptions = {
        ...(values.model !== undefined ? {model: values.model} : {}),
        ...(values.name !== undefined ? {name: values.name} : {}),
        ...(values.effort !== undefined ? {effort: values.effort} : {}),
        ...(values.workdir !== undefined ? {workdir: values.workdir} : {}),
        ...(values.resume !== undefined ? {resume: values.resume} : {}),
        ...(values.room !== undefined ? {room: values.room} : {}),
        ...(values.session !== undefined ? {session: values.session} : {}),
        ...(values.json !== undefined ? {json: values.json} : {}),
        ...(values['task-idle-timeout'] ? {taskIdleTimeoutMs: parseManagedDuration('task-idle-timeout', values['task-idle-timeout'])} : {}),
        ...(values['task-timeout'] ? {taskTimeoutMs: parseManagedDuration('task-timeout', values['task-timeout'])} : {})
    };
    if (values.resume) {
        if (positionals.length || values.model || values.name || values.effort || values.workdir || values['task-idle-timeout'] || values['task-timeout']) {
            throw new UsageError('--resume reuses the saved options; do not supply new agent settings');
        }
        if (!/^at_[0-9A-Z]{26}$/.test(values.resume)) {
            throw new UsageError('Invalid spawn operation ID');
        }
        return result;
    }
    const runtime = receiverRuntimeName(positionals[0]);
    if (!runtime || !['claude', 'codex', 'qwen'].includes(positionals[0]!)) {
        throw new UsageError('Choose a runtime: claude, codex, or qwen. Use /spawn --help for options.');
    }
    if (positionals.length > 2 || (positionals[1] !== undefined && values.model !== undefined)) {
        throw new UsageError('Use one positional model or --model; use --name and --effort for other settings');
    }
    result.runtime = runtime;
    const model = values.model ?? positionals[1];
    if (model !== undefined) {
        if (!model.trim() || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) {
            throw new UsageError('Model must be a nonempty identifier without control characters');
        }
        result.model = model;
    }
    if (values.name !== undefined && !ParticipantName.safeParse(values.name).success) {
        throw new UsageError('Name must be 1–64 characters without control characters; all is reserved');
    }
    if (values.workdir !== undefined && !values.workdir.trim()) {
        throw new UsageError('Workdir must not be empty');
    }
    if (values.effort !== undefined) {
        validateEffort(runtime, values.effort);
    }
    if (result.taskIdleTimeoutMs !== undefined && result.taskTimeoutMs !== undefined) {
        try {
            validateManagedDeadline({idleMs: result.taskIdleTimeoutMs, absoluteMs: result.taskTimeoutMs});
        } catch (error) {
            throw new UsageError(error instanceof Error ? error.message : String(error));
        }
    }
    return result;
}

export function validateEffort(runtime: ReceiverRuntimeName, effort: string): void {
    if (runtime === 'qwen') {
        throw new UsageError('Qwen effort overrides are not supported by this adapter. Omit --effort to use its provider configuration.');
    }
    const levels = runtime === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    if (!levels.includes(effort)) {
        throw new UsageError(`${runtime} effort must be one of: ${levels.join(', ')}. Model support varies.`);
    }
}

export function isAgentCommand(line: string): boolean {
    return /^\/(spawn|claude|codex|qwen|agents|agent)(?:\s|$)/.test(line);
}

export function completeAgentCommand(line: string): string[] | null {
    if (!line.startsWith('/')) {
        return null;
    }
    if (!line.includes(' ')) {
        const matches = ['/claude', '/codex', '/qwen', '/spawn', '/agents', '/agent'].filter((command) => command.startsWith(line));
        return matches.length ? matches.map((command) => command + ' ') : null;
    }
    if (!isAgentCommand(line)) {
        return null;
    }
    if (!/^\/(?:claude|codex|qwen|spawn)\s/.test(line)) {
        return [];
    }
    try {
        splitCommand(line);
    } catch {
        // A flag-looking word inside an unfinished quoted value is still data.
        return [];
    }
    if (line.startsWith('/spawn ') && line.trim().split(/\s+/).length <= 2 && !line.slice(7).includes(' ')) {
        return ['claude', 'codex', 'qwen', '--resume', '--help'].filter((word) => word.startsWith(line.slice(7))).map((word) => '/spawn ' + word + ' ');
    }
    const start = line.lastIndexOf(' ') + 1;
    const prefix = line.slice(start);
    const flags = /^\/(?:qwen|spawn qwen)\s/.test(line) ? ['--model', '--name', '--workdir', '--task-idle-timeout', '--task-timeout', '--help'] : ['--model', '--name', '--effort', '--workdir', '--task-idle-timeout', '--task-timeout', '--help'];
    return prefix.startsWith('-') ? flags.filter((flag) => flag.startsWith(prefix)).map((flag) => line.slice(0, start) + flag + ' ') : [];
}

import {closeSync, existsSync, openSync, readSync, readdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, relative, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

type JsonRecord = Record<string, unknown>;
type SessionModelOptions = {runtime: string; threadId: string; cwd: string; codexHome?: string; claudeHome?: string};
type CachedModel = {size: number; modified: number; model: string | undefined};
const transcriptCache = new Map<string, CachedModel>();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function record(value: unknown): JsonRecord | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

export function modelId(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f<>,]/.test(value) || ['default', 'auto', 'unknown'].includes(value.toLowerCase())) {
        return undefined;
    }
    return value.trim();
}

/** Only a main-session runtime frame is evidence; tool output and subagents are not. */
export function streamModel(value: unknown, threadId: string): string | undefined {
    const frame = record(value);
    if (!frame || frame['session_id'] !== threadId || frame['parent_tool_use_id'] || frame['isSidechain']) {
        return undefined;
    }
    if (frame['type'] === 'system' && ['init', 'session_start'].includes(String(frame['subtype']))) {
        return modelId(frame['model']);
    }
    if (frame['type'] === 'assistant') {
        return modelId(record(frame['message'])?.['model']);
    }
    if (frame['type'] === 'stream_event') {
        const event = record(frame['event']);
        if (event?.['type'] === 'message_start') {
            return modelId(record(event['message'])?.['model']);
        }
    }
    return undefined;
}

/** Read metadata only from the exact bound conversation; never infer from another session. */
function transcriptModel(path: string, runtime: string, threadId: string): string | undefined {
    try {
        const stat = statSync(path);
        if (!stat.isFile()) {
            return undefined;
        }
        const cached = transcriptCache.get(path);
        if (cached?.size === stat.size && cached.modified === stat.mtimeMs) {
            return cached.model;
        }
        // Bound memory and IO even for very large conversation logs. Partial
        // records are ignored; no prompt, tool output, or credential is returned.
        const length = Math.min(stat.size, 8 * 1024 * 1024);
        const start = stat.size - length;
        const buffer = Buffer.alloc(length);
        const fd = openSync(path, 'r');
        let read: number;
        try {
            read = readSync(fd, buffer, 0, length, start);
        } finally {
            closeSync(fd);
        }
        const lines = buffer.subarray(0, read).toString('utf8').split('\n');
        if (start) {
            lines.shift();
        }
        let model: string | undefined;
        for (const line of lines.reverse()) {
            try {
                const frame = record(JSON.parse(line));
                if (!frame) {
                    continue;
                }
                if (runtime === 'codex' && frame['type'] === 'turn_context') {
                    model = modelId(record(frame['payload'])?.['model']);
                } else if (runtime === 'claude' && frame['type'] === 'assistant' && frame['sessionId'] === threadId && !frame['isSidechain'] && !frame['parent_tool_use_id']) {
                    model = modelId(record(frame['message'])?.['model']);
                }
                if (model) {
                    break;
                }
            } catch {
                // A final JSONL record can still be in the middle of a write.
            }
        }
        if (transcriptCache.size >= 100) {
            transcriptCache.clear();
        }
        transcriptCache.set(path, {size: stat.size, modified: stat.mtimeMs, model});
        return model;
    } catch {
        return undefined;
    }
}

export function savedSessionModel(options: SessionModelOptions): string | undefined {
    if (!UUID.test(options.threadId)) {
        return undefined;
    }
    const runtime = options.runtime.replace(/-(cli|code)$/, '');
    if (runtime === 'claude') {
        const home = options.claudeHome ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
        const project = resolve(options.cwd).replace(/[^a-zA-Z0-9]/g, '-');
        return transcriptModel(join(home, 'projects', project, `${options.threadId}.jsonl`), runtime, options.threadId);
    }
    if (runtime !== 'codex') {
        return undefined;
    }
    const home = options.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
    for (const directory of [home, join(home, 'sqlite')]) {
        if (!existsSync(directory)) {
            continue;
        }
        let files: string[];
        try {
            files = readdirSync(directory).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
        } catch {
            continue;
        }
        for (const file of files) {
            let database: DatabaseSync | undefined;
            try {
                database = new DatabaseSync(join(directory, file), {readOnly: true});
                const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map((row) => row['name']));
                if (!columns.has('id') || !columns.has('cwd')) {
                    continue;
                }
                const fields = ['cwd', 'model', 'rollout_path'].filter((name) => columns.has(name));
                const row = database.prepare(`SELECT ${fields.join(',')} FROM threads WHERE id=?`).get(options.threadId);
                if (!row || typeof row['cwd'] !== 'string' || resolve(row['cwd']) !== resolve(options.cwd)) {
                    continue;
                }
                const reported = modelId(row['model']);
                if (reported) {
                    return reported;
                }
                const path = row['rollout_path'];
                if (typeof path === 'string' && !relative(resolve(home), resolve(path)).startsWith('..') && basename(path).endsWith(`${options.threadId}.jsonl`)) {
                    const recovered = transcriptModel(path, runtime, options.threadId);
                    if (recovered) {
                        return recovered;
                    }
                }
            } catch {
                // An older schema, locked DB, or missing transcript is unknown,
                // not evidence that the provider selected a particular model.
            } finally {
                database?.close();
            }
        }
    }
    return undefined;
}

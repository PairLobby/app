import {appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, expect, test, vi} from 'vitest';
import {modelId, savedSessionModel, streamModel} from './model-metadata.js';
import {CodexReceiver} from './codex-receiver.js';
import {sameRuntime} from './runtime-detect.js';
import type {MessageRequest} from '@pairlobby/protocol';

const id = '11111111-1111-7111-8111-111111111111';
const other = '22222222-2222-7222-8222-222222222222';
const directories: string[] = [];
function temporary(): string {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-model-'));
    directories.push(directory);
    return directory;
}
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) { rmSync(directory, {recursive: true, force: true}); } });

test('runtime aliases preserve the caller identity without mixing providers', () => {
    expect(sameRuntime('codex', 'codex-cli')).toBe(true);
    expect(sameRuntime('claude', 'claude-code')).toBe(true);
    expect(sameRuntime('qwen', 'qwen-code')).toBe(true);
    expect(sameRuntime('codex', 'claude-code')).toBe(false);
    expect(sameRuntime(undefined, undefined)).toBe(false);
});

test('Codex publishes the thread model and reroutes, then restores the selected model for the next turn', async () => {
    const directory = temporary();
    vi.stubEnv('PAIRLOBBY_TEST_RECORD', join(directory, 'calls'));
    vi.stubEnv('PAIRLOBBY_ROOM', 'model-room');
    vi.stubEnv('PAIRLOBBY_SESSION', 'model-session');
    const runtime = new CodexReceiver({cwd: directory, executable: process.execPath, args: [resolve('scripts/fixtures/codex-receiver.mjs')], roomId: 'model-room', sessionId: 'model-session'});
    const models: string[] = [];
    const hooks = {acknowledge: async () => {}, started: () => {}, usage: () => {}, model: (model: string) => { models.push(model); }};
    const request: MessageRequest = {roomId: 'model-room', eventId: 'r', seq: 1, from: 'user', to: 'agent', text: 'reroute-fixture', at: 0, requiresReply: true, receivedAt: null, responseEventId: null, respondedAt: null, progressAt: null};
    try {
        await runtime.connect();
        await runtime.execute(request, hooks);
        expect(models).toEqual(['fixture-model', 'gpt-6-sol']);
        expect(runtime.model).toBe('gpt-6-sol');
        await runtime.execute({...request, text: 'ordinary follow-up'}, hooks);
        expect(models.at(-1)).toBe('fixture-model');
        expect(runtime.model).toBe('fixture-model');
    } finally {
        runtime.close();
    }
});

test('captures the resolved model at startup and main assistant messages for both stream runtimes', () => {
    expect(streamModel({type: 'system', subtype: 'init', session_id: id, model: 'claude-opus-5-5'}, id)).toBe('claude-opus-5-5');
    expect(streamModel({type: 'system', subtype: 'session_start', session_id: id, model: 'qwen3-coder-plus'}, id)).toBe('qwen3-coder-plus');
    expect(streamModel({type: 'assistant', session_id: id, message: {model: 'claude-haiku-4-5'}}, id)).toBe('claude-haiku-4-5');
    expect(streamModel({type: 'stream_event', session_id: id, event: {type: 'message_start', message: {model: 'claude-sonnet-4-5'}}}, id)).toBe('claude-sonnet-4-5');
});

test('never substitutes subagent, wrong-session, synthetic, tool, or cumulative usage models', () => {
    const frame = {type: 'assistant', session_id: id, message: {model: 'claude-haiku-4-5'}};
    expect(streamModel({...frame, parent_tool_use_id: 'nested-task'}, id)).toBeUndefined();
    expect(streamModel({...frame, isSidechain: true}, id)).toBeUndefined();
    expect(streamModel({...frame, session_id: other}, id)).toBeUndefined();
    expect(streamModel({...frame, type: 'tool_result'}, id)).toBeUndefined();
    expect(streamModel({type: 'result', session_id: id, modelUsage: {'claude-haiku-4-5': {}, 'claude-opus-5-5': {}}}, id)).toBeUndefined();
    for (const value of ['<synthetic>', 'default', 'auto', 'one,two', '\x1b[31mhidden', '', null]) {
        expect(modelId(value)).toBeUndefined();
    }
});

test('recovers only the bound Claude main conversation and follows a later model change', () => {
    const home = temporary();
    const cwd = join(home, 'project');
    const directory = join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(directory, {recursive: true});
    const path = join(directory, `${id}.jsonl`);
    writeFileSync(path, [
        {type: 'assistant', sessionId: id, message: {model: 'claude-opus-5-5'}},
        {type: 'assistant', sessionId: other, message: {model: 'wrong-session'}},
        {type: 'assistant', sessionId: id, isSidechain: true, message: {model: 'nested-agent'}},
        {type: 'assistant', sessionId: id, message: {model: '<synthetic>'}}
    ].map((frame) => JSON.stringify(frame)).join('\n') + '\n');
    const options = {runtime: 'claude', threadId: id, cwd, claudeHome: home};
    expect(savedSessionModel(options)).toBe('claude-opus-5-5');
    appendFileSync(path, JSON.stringify({type: 'assistant', sessionId: id, message: {model: 'claude-sonnet-4-5'}}) + '\n{"partial":');
    expect(savedSessionModel(options)).toBe('claude-sonnet-4-5');
    expect(savedSessionModel({...options, cwd: join(home, 'other-project')})).toBeUndefined();
    expect(savedSessionModel({...options, threadId: '../credentials'})).toBeUndefined();
});

test('reads a Codex session index read-only and never borrows a model from another conversation', () => {
    const home = temporary();
    const cwd = join(home, 'project');
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, model TEXT)');
    db.prepare('INSERT INTO threads VALUES (?,?,?)').run(id, cwd, 'gpt-6-astra');
    db.prepare('INSERT INTO threads VALUES (?,?,?)').run(other, cwd, 'gpt-6-sol');
    db.close();
    const options = {runtime: 'codex', threadId: id, cwd, codexHome: home};
    expect(savedSessionModel(options)).toBe('gpt-6-astra');
    expect(savedSessionModel({...options, threadId: other})).toBe('gpt-6-sol');
    expect(savedSessionModel({...options, cwd: '/unrelated'})).toBeUndefined();
});

test('older Codex indexes recover turn metadata without reading arbitrary indexed files', () => {
    const home = temporary();
    const path = join(home, `rollout-${id}.jsonl`);
    writeFileSync(path, JSON.stringify({type: 'turn_context', payload: {model: 'gpt-5.6-terra'}}) + '\n');
    const db = new DatabaseSync(join(home, 'state_4.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT)');
    db.prepare('INSERT INTO threads VALUES (?,?,?)').run(id, home, path);
    db.close();
    expect(savedSessionModel({runtime: 'codex', threadId: id, cwd: home, codexHome: home})).toBe('gpt-5.6-terra');
});

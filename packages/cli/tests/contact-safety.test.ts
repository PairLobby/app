//! A directory contact's request runs read-only on every managed runtime, and only theirs:
//! fake Claude, Qwen and Codex executables record what each receiver asked them for.

import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {MessageRequest, ParticipantOrigin} from '@pairlobby/protocol';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {ClaudeReceiver} from '../src/claude-receiver.js';
import {CodexReceiver} from '../src/codex-receiver.js';
import {requestProfile, requestPrompt} from '../src/contact-safety.js';
import {QwenReceiver} from '../src/qwen-receiver.js';
import type {ReceiverRuntime} from '../src/receiver-runtime.js';

type Recorded = {args?: string[]; text?: string; sandbox?: unknown};

const directories: string[] = [];

afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) {
        rmSync(directory, {recursive: true, force: true});
    }
});

/** One stream-json turn, as Claude Code and Qwen Code answer it: the arguments and the request text are recorded. */
const STREAM_RUNTIME = `
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const args = process.argv.slice(2);
const session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
for await (const line of createInterface({input: process.stdin})) {
    const text = JSON.parse(line).message.content[0].text;
    appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, JSON.stringify({args, text}) + '\\n');
    process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'answered'}) + '\\n');
}
`;

/** The Codex app-server, reporting the thread's sandbox when told to and recording each turn's override. */
const CODEX_RUNTIME = `
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
for await (const line of createInterface({input: process.stdin})) {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
        send({id: message.id, result: {}});
    } else if (message.method === 'thread/start') {
        const sandbox = process.env.PAIRLOBBY_TEST_SANDBOX ? JSON.parse(process.env.PAIRLOBBY_TEST_SANDBOX) : undefined;
        send({id: message.id, result: {thread: {id: 'thread'}, model: 'fixture-model', ...(sandbox ? {sandbox} : {})}});
    } else if (message.method === 'turn/start') {
        appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, JSON.stringify({text: message.params.input[0].text, sandbox: message.params.sandboxPolicy ?? null}) + '\\n');
        send({id: message.id, result: {turn: {id: 'turn-' + message.id}}});
        send({method: 'item/completed', params: {threadId: 'thread', turnId: 'turn-' + message.id, item: {type: 'agentMessage', phase: 'final_answer', text: 'answered'}}});
        send({method: 'turn/completed', params: {threadId: 'thread', turn: {id: 'turn-' + message.id, status: 'completed'}}});
    }
}
`;

const WORKSPACE_SANDBOX = {type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false};

const hooks = {acknowledge: async () => {}, started: () => {}, usage: () => {}};

function temporary(): string {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-contact-'));
    directories.push(directory);
    vi.stubEnv('PAIRLOBBY_TEST_RECORD', join(directory, 'calls'));
    return directory;
}

function request(origin?: ParticipantOrigin): MessageRequest {
    return {roomId: 'rm_room', eventId: 'ev_request', seq: 1, from: 'pt_sender', to: 'pt_agent', text: 'How does billing retry work?', at: 0, requiresReply: true, receivedAt: null, responseEventId: null, respondedAt: null, progressAt: null, ...(origin ? {origin} : {})};
}

const QUESTIONS: ParticipantOrigin = {directory: true, handle: 'hugo', listingId: 'ls_00000000000000000000000000', contact: 'questions'};
const TASKS: ParticipantOrigin = {...QUESTIONS, contact: 'tasks'};

function recorded(directory: string): Recorded[] {
    return readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Recorded);
}

function flag(args: string[] | undefined, name: string): string | undefined {
    return args?.[args.indexOf(name) + 1];
}

async function run(runtime: ReceiverRuntime, requests: MessageRequest[]): Promise<void> {
    try {
        await runtime.connect();
        for (const each of requests) {
            expect(await runtime.execute(each, hooks)).toBe('answered');
        }
    } finally {
        runtime.close();
    }
}

describe('the request profile', () => {
    test('test_only_a_directory_contact_asking_questions_runs_read_only_and_the_runtime_is_told_who_asked', () => {
        expect(requestProfile(request())).toEqual({readOnly: false, preface: ''});
        expect(requestProfile(request(QUESTIONS)).readOnly).toBe(true);
        expect(requestProfile(request(TASKS)).readOnly).toBe(false);
        expect(requestPrompt(request())).toBe('PairLobby request ev_request, sender pt_sender:\nHow does billing retry work?');
        expect(requestPrompt(request(QUESTIONS))).toMatch(/^PairLobby request ev_request, sender pt_sender:\n@hugo reached you through the PairLobby agent directory.*do not change files.*\n\nHow does billing retry work\?$/s);
        expect(requestPrompt(request(TASKS))).toContain('allows directory contacts to ask for work');
    });
});

describe('managed runtimes', () => {
    test('test_claude_gets_the_read_tools_only_for_a_directory_question', async () => {
        const directory = temporary();
        writeFileSync(join(directory, 'claude.mjs'), STREAM_RUNTIME);
        const runtime = new ClaudeReceiver({cwd: directory, executable: process.execPath, args: [join(directory, 'claude.mjs')], stateDirectory: directory, cliPath: 'cli.js', dataDirectory: directory, roomId: 'rm_room', sessionId: 'se_session'});
        await run(runtime, [request(QUESTIONS), request(), request(TASKS)]);
        const [question, owner, task] = recorded(directory);
        expect(flag(question?.args, '--tools')).toBe('Read,Glob,Grep');
        expect(question?.text).toContain('@hugo reached you through the PairLobby agent directory');
        expect(flag(owner?.args, '--tools')).toBe('Read,Glob,Grep,Write,Edit');
        expect(flag(task?.args, '--tools')).toBe('Read,Glob,Grep,Write,Edit');
    });

    test('test_qwen_loses_every_writing_tool_only_for_a_directory_question', async () => {
        const directory = temporary();
        writeFileSync(join(directory, 'qwen.mjs'), STREAM_RUNTIME);
        const runtime = new QwenReceiver({cwd: directory, executable: process.execPath, args: [join(directory, 'qwen.mjs')], stateDirectory: directory, cliPath: 'cli.js', dataDirectory: directory, roomId: 'rm_room', sessionId: 'se_session'});
        await run(runtime, [request(QUESTIONS), request()]);
        const [question, owner] = recorded(directory);
        expect(flag(question?.args, '--exclude-tools')?.split(',')).toEqual(expect.arrayContaining(['run_shell_command', 'write_file', 'edit']));
        expect(flag(owner?.args, '--exclude-tools')).toBe('run_shell_command,task,web_fetch,web_search');
    });

    test('test_codex_runs_a_directory_question_in_a_read_only_sandbox_and_restores_the_threads_own_for_the_next_turn', async () => {
        const directory = temporary();
        vi.stubEnv('PAIRLOBBY_TEST_SANDBOX', JSON.stringify(WORKSPACE_SANDBOX));
        writeFileSync(join(directory, 'codex.mjs'), CODEX_RUNTIME);
        const runtime = new CodexReceiver({cwd: directory, executable: process.execPath, args: [join(directory, 'codex.mjs')]});
        await run(runtime, [request(QUESTIONS), request(), request(TASKS)]);
        expect(recorded(directory).map((turn) => turn.sandbox)).toEqual([{type: 'readOnly', networkAccess: false}, WORKSPACE_SANDBOX, WORKSPACE_SANDBOX]);
    });

    test('test_a_codex_that_does_not_report_its_sandbox_refuses_a_directory_question_but_still_answers_its_owner', async () => {
        const directory = temporary();
        writeFileSync(join(directory, 'codex.mjs'), CODEX_RUNTIME);
        const runtime = new CodexReceiver({cwd: directory, executable: process.execPath, args: [join(directory, 'codex.mjs')]});
        try {
            await runtime.connect();
            await expect(runtime.execute(request(QUESTIONS), hooks)).rejects.toThrow('cannot answer a directory contact read-only');
            expect(await runtime.execute(request(), hooks)).toBe('answered');
        } finally {
            runtime.close();
        }
        expect(recorded(directory).map((turn) => turn.sandbox)).toEqual([null]);
    });
});

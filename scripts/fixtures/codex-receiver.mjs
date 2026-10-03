#!/usr/bin/env node
// Protocol fixture: no model provider or network calls.
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let turn = '';
let text = '';
for await (const line of createInterface({input: process.stdin})) {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
        send({id: message.id, result: {}});
    } else if (['thread/start', 'thread/resume'].includes(message.method)) {
        if (!message.params.developerInstructions.includes(process.env.PAIRLOBBY_ROOM) || !message.params.developerInstructions.includes(process.env.PAIRLOBBY_SESSION)) {
            throw new Error('Missing receiver room/session scope');
        }
        appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, message.method + '\n');
        send({id: message.id, result: {thread: {id: 'test-thread'}, model: message.params.model ?? 'fixture-model'}});
    } else if (message.method === 'model/list') {
        send({id: message.id, result: {data: [{id: 'fixture-model', model: 'fixture-model', supportedReasoningEfforts: [{reasoningEffort: 'medium'}, {reasoningEffort: 'high'}]}], nextCursor: null}});
    } else if (message.method === 'turn/start') {
        turn = `turn-${message.id}`;
        text = message.params.input[0].text;
        appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, 'turn/start\n');
        if (message.params.effort) {
            appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, `effort:${message.params.effort}\n`);
        }
        send({id: message.id, result: {turn: {id: turn}}});
        if (text.includes('hold-for-interrupt')) {
            // A long turn with one shell command running, until the receiver interrupts it.
            send({method: 'item/started', params: {threadId: 'test-thread', turnId: turn, item: {type: 'commandExecution', id: 'cmd-1', status: 'inProgress'}}});
            continue;
        }
        if (!text.includes('hang-until-crash')) {
            send({id: 'approval', method: 'item/commandExecution/requestApproval', params: {threadId: 'test-thread', turnId: turn}});
        }
    } else if (message.method === 'turn/interrupt') {
        appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, 'turn/interrupt\n');
        send({id: message.id, result: {}});
        // Unless the test wants the command to outlive the turn, Codex reports it ended.
        if (!text.includes('command-lingers')) {
            send({method: 'item/completed', params: {threadId: 'test-thread', turnId: turn, item: {type: 'commandExecution', id: 'cmd-1', status: 'failed'}}});
        }
        send({method: 'turn/completed', params: {threadId: 'test-thread', turn: {id: message.params.turnId, status: 'interrupted'}}});
    } else if (message.id === 'approval') {
        appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, `approval:${message.result.decision}\n`);
        send({id: 'ack', method: 'item/tool/call', params: {threadId: 'test-thread', turnId: turn, tool: 'pairlobby_acknowledge', arguments: {}}});
    } else if (message.id === 'ack' || message.id === 'pass' || message.id === 'working' || message.id === 'decision') {
        if (!message.result.success) {
            throw new Error('Acknowledgement failed');
        }
        if (message.id === 'ack' && text.includes('no-action-fixture')) {
            send({id: 'decision', method: 'item/tool/call', params: {threadId: 'test-thread', turnId: turn, tool: 'pairlobby_message_status', arguments: {state: 'no_action', reason: 'No further work needed'}}});
            continue;
        }
        if (message.id === 'ack' && text.includes('codex-pass')) {
            send({id: 'pass', method: 'item/tool/call', params: {threadId: 'test-thread', turnId: turn, tool: 'pairlobby_pass', arguments: {}}});
            continue;
        }
        if (message.id === 'ack' && text.includes('declare-working')) {
            send({id: 'working', method: 'item/tool/call', params: {threadId: 'test-thread', turnId: turn, tool: 'pairlobby_working', arguments: {}}});
            continue;
        }
        await sleep(Number(process.env.PAIRLOBBY_TEST_DELAY_MS ?? 0));
        if (text.includes('reroute-fixture')) {
            send({method: 'model/rerouted', params: {threadId: 'another-thread', turnId: turn, fromModel: 'fixture-model', toModel: 'wrong-thread-model'}});
            send({method: 'model/rerouted', params: {threadId: 'test-thread', turnId: turn, fromModel: 'fixture-model', toModel: 'gpt-6-sol'}});
        }
        send({method: 'item/completed', params: {threadId: 'test-thread', turnId: turn, item: {type: 'agentMessage', phase: 'final_answer', text: 'Fixture answer: ' + text}}});
        send({method: 'turn/completed', params: {threadId: 'test-thread', turn: {id: turn, status: 'completed'}}});
    }
}

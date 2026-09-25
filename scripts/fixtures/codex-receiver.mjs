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
        send({id: message.id, result: {thread: {id: 'test-thread'}}});
    } else if (message.method === 'turn/start') {
        turn = `turn-${message.id}`;
        text = message.params.input[0].text;
        appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, 'turn/start\n');
        send({id: message.id, result: {turn: {id: turn}}});
        if (!text.includes('hang-until-crash')) {
            send({id: 'approval', method: 'item/commandExecution/requestApproval', params: {threadId: 'test-thread', turnId: turn}});
        }
    } else if (message.id === 'approval') {
        appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, `approval:${message.result.decision}\n`);
        send({id: 'ack', method: 'item/tool/call', params: {threadId: 'test-thread', turnId: turn, tool: 'pairlobby_acknowledge', arguments: {}}});
    } else if (message.id === 'ack' || message.id === 'pass') {
        if (!message.result.success) {
            throw new Error('Acknowledgement failed');
        }
        if (message.id === 'ack' && text.includes('codex-pass')) {
            send({id: 'pass', method: 'item/tool/call', params: {threadId: 'test-thread', turnId: turn, tool: 'pairlobby_pass', arguments: {}}});
            continue;
        }
        await sleep(Number(process.env.PAIRLOBBY_TEST_DELAY_MS ?? 0));
        send({method: 'item/completed', params: {threadId: 'test-thread', turnId: turn, item: {type: 'agentMessage', phase: 'final_answer', text: 'Fixture answer: ' + text}}});
        send({method: 'turn/completed', params: {threadId: 'test-thread', turn: {id: turn, status: 'completed'}}});
    }
}

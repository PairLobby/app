#!/usr/bin/env node
// Qwen stream-json fixture. The acknowledgement goes through the real scoped MCP server.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {appendFileSync, readFileSync} from 'node:fs';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const record = (line) => appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, line + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const session = args.includes('--resume') ? value('--resume') : value('--session-id');
if (value('--model') !== 'fixture-model') {
    throw new Error('Receiver did not preserve its model selection');
}
if (!args.includes('--bare') || value('--approval-mode') !== 'default' || value('--allowed-mcp-server-names') !== 'pairlobby_receiver' || value('--allowed-tools') !== 'mcp__pairlobby_receiver__acknowledge_message' || !value('--exclude-tools').includes('run_shell_command')) {
    throw new Error('Missing restricted receiver policy');
}
record(args.includes('--resume') ? 'thread/resume' : 'thread/start');
const source = createInterface({input: process.stdin});
for await (const line of source) {
    const input = JSON.parse(line);
    if (input.type === 'control_response') {
        if (input.response.response?.behavior !== 'deny') throw new Error('Background approval was not declined');
        record('approval:decline');
        continue;
    }
    const text = input.message.content[0].text;
    record('turn/start');
    if (text.includes('hang-until-crash')) {
        continue;
    }
    if (text.includes('no-ack')) {
        send({type: 'result', subtype: 'success', session_id: session, result: 'Unacknowledged answer'});
        continue;
    }
    send({type: 'control_request', request_id: 'approval-probe', request: {subtype: 'can_use_tool', tool_name: 'write_file', input: {}}});
    const config = JSON.parse(readFileSync(value('--mcp-config'), 'utf8')).mcpServers.pairlobby_receiver;
    const child = spawn(config.command, config.args, {env: {...process.env, ...config.env}, stdio: ['pipe', 'pipe', 'pipe']});
    const messages = createInterface({input: child.stdout});
    child.stderr.on('data', () => {});
    const waiters = new Map();
    messages.on('line', (raw) => {
        const reply = JSON.parse(raw);
        if (reply.id !== undefined) {
            waiters.get(reply.id)?.(reply);
            waiters.delete(reply.id);
        }
    });
    const call = (id, method, params) => new Promise((resolve) => {
        waiters.set(id, resolve);
        child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    });
    await call(1, 'initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'qwen-fixture', version: '1'}});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
    const invalid = text.includes('invalid-ack');
    const ack = await call(2, 'tools/call', {name: 'acknowledge_message', arguments: invalid ? {eventId: 'ev_other'} : {}});
    if (invalid ? !ack.result?.isError : ack.result?.isError) {
        throw new Error('Unexpected scoped acknowledgement result');
    }
    record(invalid ? 'ack:rejected' : 'ack:confirmed');
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
    send({type: 'result', subtype: invalid ? 'error_ack' : 'success', is_error: invalid, session_id: session, result: invalid ? '' : 'Qwen fixture answer: ' + text, usage: {input_tokens: 10, output_tokens: 10}});
}
record('process/exit');

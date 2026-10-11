#!/usr/bin/env node
// Claude stream-json fixture. The acknowledgement goes through the real scoped MCP server.
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {createInterface} from 'node:readline';
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
    console.log('--model <model>\n--effort <level> (low, medium, high, xhigh, max)');
    process.exit(0);
}
const value = (flag) => args[args.indexOf(flag) + 1];
const record = (line) => appendFileSync(process.env.PAIRLOBBY_TEST_RECORD, line + '\n');
if (args.includes('--effort')) {
    record(`effort:${value('--effort')}`);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const session = args.includes('--resume') ? value('--resume') : value('--session-id');
if (value('--model') !== 'fixture-model') {
    throw new Error('Receiver did not preserve its model selection');
}
if (!args.includes('--restricted') || value('--permission-mode') !== 'acceptEdits' || value('--tools') !== 'Read,Glob,Grep,Write,Edit' || !args.includes('--strict-mcp-config')) {
    throw new Error('Missing restricted receiver policy');
}
record(args.includes('--resume') ? 'thread/resume' : 'thread/start');
const source = createInterface({input: process.stdin});
let heldText = '';
let usageLimited = false;
for await (const line of source) {
    const input = JSON.parse(line);
    if (input.type === 'control_request') {
        // An interrupt ends the held turn with an error result unless the test wants it ignored.
        if (input.request?.subtype === 'interrupt' && !heldText.includes('ignore-interrupt')) {
            record('interrupt');
            send({type: 'control_response', response: {subtype: 'success', request_id: input.request_id}});
            send({type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session});
        }
        continue;
    }
    const text = input.message.content[0].text;
    record('turn/start');
    send({type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5'});
    const usageLimitMarker = process.env.PAIRLOBBY_TEST_USAGE_LIMIT_ONCE;
    const usageLimitCount = Number(process.env.PAIRLOBBY_TEST_USAGE_LIMIT_COUNT ?? (usageLimitMarker ? 1 : Number.POSITIVE_INFINITY));
    const reportedLimits = usageLimitMarker && existsSync(usageLimitMarker) ? Number(readFileSync(usageLimitMarker, 'utf8').trim()) || 0 : 0;
    if (text.includes('usage-limit-fixture') && reportedLimits < usageLimitCount) {
        if (usageLimitMarker) {
            writeFileSync(usageLimitMarker, `${reportedLimits + 1}\n`);
        }
        usageLimited = true;
        const limitText = process.env.PAIRLOBBY_TEST_USAGE_LIMIT_TEXT ?? "You've hit your session limit · resets 6:20pm (America/Toronto)";
        process.stderr.write(`${limitText}\nUse your limit reset to reset it now: https://clau.de/reset\n`);
        send({type: 'result', subtype: 'success', is_error: false, session_id: session, result: limitText, errors: [], usage: {input_tokens: 0, output_tokens: 0}});
        break;
    }
    if (text.includes('hang-until-crash') || text.includes('hold-for-interrupt')) {
        heldText = text;
        continue;
    }
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
    await call(1, 'initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'claude-fixture', version: '1'}});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
    const invalid = text.includes('invalid-ack');
    const ack = await call(2, 'tools/call', {name: 'acknowledge_message', arguments: invalid ? {eventId: 'ev_other'} : {}});
    if (invalid ? !ack.result?.isError : ack.result?.isError) {
        throw new Error('Unexpected scoped acknowledgement result');
    }
    record(invalid ? 'ack:rejected' : 'ack:confirmed');
    if (!invalid && text.includes('declare-working')) {
        const working = await call(4, 'tools/call', {name: 'working_message', arguments: {}});
        if (working.result?.isError) throw new Error('Working declaration rejected');
        record('working:confirmed');
    }
    if (!invalid && text.includes('claude-pass')) {
        const passed = await call(3, 'tools/call', {name: 'pass_message', arguments: {}});
        if (passed.result?.isError) throw new Error('Pass was rejected');
        record('pass:confirmed');
    }
    if (!invalid && text.includes('no-action-fixture')) {
        const decision = await call(5, 'tools/call', {name: 'message_status', arguments: {state: 'no_action', reason: 'No further work needed'}});
        if (decision.result?.isError) throw new Error('Decision rejected');
    }
    // With a heartbeat set, the wait is busy: output keeps arriving, as from a model that is still working.
    for (let waited = 0, beat = Number(process.env.PAIRLOBBY_TEST_HEARTBEAT_MS ?? 0), delay = Number(process.env.PAIRLOBBY_TEST_DELAY_MS ?? 0); waited < delay; waited += beat || delay) {
        await sleep(Math.min(beat || delay, delay - waited));
        if (beat) {
            send({type: 'system', subtype: 'status', session_id: session});
        }
    }
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
    send({type: 'result', subtype: invalid ? 'error_ack' : 'success', is_error: invalid, session_id: session, result: invalid ? '' : 'Claude fixture answer: ' + text, usage: {input_tokens: 10, output_tokens: 10}});
}
record('process/exit');
if (usageLimited) process.exitCode = 1;

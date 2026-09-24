// Real Qwen CLI + a loopback OpenAI fixture: no provider credentials or paid inference.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {PairLobbyClient} from '../packages/client/dist/index.js';
import {startServer} from '../packages/local-server/dist/index.js';

const qwenCli = process.env.PAIRLOBBY_QWEN_CLI;
if (!qwenCli) throw new Error('Set PAIRLOBBY_QWEN_CLI to the installed Qwen Code cli-entry.js.');
const root = mkdtempSync(join(tmpdir(), 'pairlobby-qwen-live-'));
const cli = process.env.PAIRLOBBY_TEST_CLI ?? resolve('packages/cli/dist/main.js');
let requests = 0;
const provider = createServer(async (request, response) => {
    try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (!request.url.endsWith('/chat/completions')) throw new Error('Unexpected model endpoint: ' + request.url);
        requests++;
        const messages = body.messages;
        const taskIndex = messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('PairLobby request ev_'));
        const received = messages.slice(taskIndex + 1).some(message => message.role === 'tool');
        const acknowledgement = body.tools?.find(tool => tool.function?.name.includes('acknowledge_message'))?.function.name;
        if (!received && !acknowledgement) throw new Error('Scoped receipt tool was not exposed to Qwen');
        const delta = received
            ? {role: 'assistant', content: 'Qwen loopback fixture completed the request.'}
            : {role: 'assistant', tool_calls: [{index: 0, id: `call_ack_${requests}`, type: 'function', function: {name: acknowledgement, arguments: '{}'}}]};
        response.writeHead(200, {'content-type': 'text/event-stream'});
        const frame = {id: `chatcmpl-${requests}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture-model'};
        response.write(`data: ${JSON.stringify({...frame, choices: [{index: 0, delta, finish_reason: null}]})}\n\n`);
        response.end(`data: ${JSON.stringify({...frame, choices: [{index: 0, delta: {}, finish_reason: received ? 'stop' : 'tool_calls'}], usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}})}\n\ndata: [DONE]\n\n`);
    } catch (error) {
        response.writeHead(500, {'content-type': 'application/json'});
        response.end(JSON.stringify({error: {message: error.message}}));
    }
});
await new Promise(resolveReady => provider.listen(0, '127.0.0.1', resolveReady));
const relay = await startServer({port: 0, dataFile: join(root, 'relay.sqlite')});
const client = new PairLobbyClient(relay.url);
const host = await client.createRoom('Qwen runtime check', {displayName: 'fixture owner', kind: 'human'});
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const wrapper = join(root, 'qwen');
writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(qwenCli))} --auth-type openai --openai-base-url http://127.0.0.1:${provider.address().port}/v1 --openai-api-key pairlobby-test-only "$@"\n`);
chmodSync(wrapper, 0o755);
const environment = {...process.env, PATH: `${root}:${process.env.PATH}`, PAIRLOBBY_DATA_DIR: join(root, 'device')};
function command(args) {
    return new Promise((resolveDone, reject) => {
        const child = spawn(process.execPath, [cli, ...args, '--json'], {env: environment, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000});
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolveDone(JSON.parse(stdout)) : reject(new Error(stderr)));
    });
}
let member;
try {
    member = await command(['join', host.invite.code, '--server', relay.url, '--runtime', 'qwen', '--as', 'qwen', '--workdir', root, '--model', 'fixture-model']);
    assert.equal(member.receiver.state, 'available');
    await sleep(1200);
    assert.equal(requests, 0, 'idle membership must not start inference');
    let thread;
    for (const key of ['first', 'second']) {
        const sent = await client.send(host.roomId, host.participantCredential, {type: 'message', recipientId: member.participantId, payload: {text: `Acknowledge and answer the ${key} test request.`, priority: 'normal'}, idempotencyKey: key});
        let outcome;
        for (let attempt = 0; attempt < 150; attempt++) {
            outcome = await client.request(host.roomId, host.participantCredential, sent.event.eventId);
            if (outcome.failureAt || outcome.responseEventId) break;
            await sleep(200);
        }
        assert.equal(outcome.failureAt ?? null, null, outcome.failureReason);
        assert.ok(outcome.receivedAt, 'Qwen must invoke the real scoped acknowledgement tool');
        assert.ok(outcome.responseEventId, 'Qwen must provide a correlated final reply');
        const state = JSON.parse(readFileSync(join(environment.PAIRLOBBY_DATA_DIR, 'receivers', member.sessionId, 'qwen-session.json'), 'utf8'));
        assert.equal(state.completed, true);
        if (thread) assert.equal(state.threadId, thread, 'follow-up must resume the completed conversation');
        thread = state.threadId;
    }
    assert.equal(requests, 4, 'one acknowledgement and one answer per request');
    console.log('PASS real Qwen CLI: idle without inference, scoped acknowledgements, correlated replies and session resume through a loopback model fixture.');
} finally {
    if (member) await command(['receiver', 'stop', '--room', host.roomId, '--session', member.sessionId]);
    await relay.close();
    provider.closeAllConnections();
    await new Promise(resolveClosed => provider.close(resolveClosed));
    rmSync(root, {recursive: true, force: true});
}

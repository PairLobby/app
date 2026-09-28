import {expect, test} from 'vitest';
import {completeAgentCommand, isAgentCommand, parseSpawnOptions, splitCommand} from './spawn-options.js';

test('spawn arguments preserve quoted values without evaluating shell input', () => {
    expect(parseSpawnOptions(splitCommand('claude opus --name "Code reviewer" --effort high --workdir "/tmp/my project"'))).toMatchObject({runtime: 'claude', model: 'opus', name: 'Code reviewer', effort: 'high', workdir: '/tmp/my project'});
    expect(splitCommand("qwen --name '$(touch /tmp/never)' ")).toEqual(['qwen', '--name', '$(touch /tmp/never)']);
    expect(parseSpawnOptions(['codex'])).toEqual({runtime: 'codex'});
    expect(parseSpawnOptions(['codex', '--model', 'custom-model', '--json', '--room', 'room'], true)).toMatchObject({runtime: 'codex', model: 'custom-model', json: true, room: 'room'});
});

test.each([
    ['claude', 'model', 'name'], ['codex', 'model', '--model', 'other'], ['claude', '--name', 'all'],
    ['claude', '--name', ''], ['claude', '--name', 'a', '--name', 'b'], ['qwen', '--effort', 'high'],
    ['codex', '--effort', 'invented'], ['deepseek'], ['claude', '--workdir', ''], ['codex', '--unknown'],
    ['codex', '--session', 'someone-else'], ['--resume', 'bad'], ['codex', '--model', ''], ['--resume', 'at_' + 'A'.repeat(26), '--name', 'changed']
])('invalid spawn command fails before it can create an agent: %j', (...args) => {
    expect(() => parseSpawnOptions(args)).toThrow();
});

test('help is local and unclosed quoting fails', () => {
    expect(parseSpawnOptions(['--help'])).toEqual({help: true});
    expect(() => splitCommand('claude --name "unfinished')).toThrow('Unclosed');
    expect(() => splitCommand('claude \\')).toThrow('Incomplete');
});

test('agent commands are recognized and completed without treating mentions as commands', () => {
    expect(isAgentCommand('/codex --name test')).toBe(true);
    expect(isAgentCommand('@codex /spawn qwen')).toBe(false);
    expect(completeAgentCommand('/cod')).toEqual(['/codex ']);
    expect(completeAgentCommand('/spawn qw')).toEqual(['/spawn qwen ']);
    expect(completeAgentCommand('/claude --wo')).toEqual(['/claude --workdir ']);
});

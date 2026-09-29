import {expect, test} from 'vitest';
import {stripVTControlCharacters} from 'node:util';
import {CHAT_COMMANDS, commandHint, commandMatches, completeChatCommand} from './chat-completion.js';

test('slash suggestions cover every command and narrow while typing', () => {
    expect(commandMatches('/')).toEqual(CHAT_COMMANDS.map((command) => command + ' '));
    expect(commandMatches('/sta')).toEqual(['/status ']);
    expect(completeChatCommand('/sta')).toEqual([['/status '], '/sta']);
    expect(commandHint('/sta')).toContain('/sta');
    expect(stripVTControlCharacters(commandHint('/sta')!)).toContain('tab to complete');
    expect(commandHint('/not-real')).toContain('No command matches');
    expect(commandHint('/')).toContain('more');
    expect(new Set(CHAT_COMMANDS).size).toBe(CHAT_COMMANDS.length);
});

test('Tab extends a shared prefix without choosing an ambiguous command', () => {
    expect(completeChatCommand('/ag')).toEqual([['/agent'], '/ag']);
    expect(completeChatCommand('/agent')).toEqual([[], '/agent']);
    expect(commandMatches('/agent')).toEqual(['/agents ', '/agent ']);
    expect(completeChatCommand('/agent st')).toEqual([[], '/agent st']);
    expect(completeChatCommand('/turns par')).toEqual([['/turns parallel '], '/turns par']);
    expect(completeChatCommand('/invite a')).toEqual([['/invite as '], '/invite a']);
});

test('command detection respects cursor position and leaves ordinary text and mentions alone', () => {
    expect(commandHint('please /sta')).toBeNull();
    expect(commandHint('@codex')).toBeNull();
    expect(completeChatCommand('/to @co')).toBeNull();
    expect(commandHint('/sta rest', 4)).toContain('/sta');
    expect(commandHint('/status ')).toBeNull();
    expect(commandHint('/name New Name')).toBeNull();
});

test('spawn completions keep runtime options and omit unsupported Qwen effort', () => {
    expect(completeChatCommand('/spawn qw')).toEqual([['/spawn qwen '], '/spawn qw']);
    expect(completeChatCommand('/claude --wo')).toEqual([['/claude --workdir '], '/claude --wo']);
    expect(commandMatches('/codex --')).toContain('/codex --effort ');
    expect(commandMatches('/qwen --')).not.toContain('/qwen --effort ');
    expect(commandMatches('/spawn qwen --')).not.toContain('/spawn qwen --effort ');
    expect(commandMatches('/agents --')).toEqual([]);
    expect(commandMatches('/agent start --')).toEqual([]);
    expect(commandMatches('/claude --name "Agent --')).toEqual([]);
});

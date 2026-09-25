import {expect, test} from 'vitest';
import type {TurnEntry} from '@pairlobby/protocol';
import {WorkingView, logoProvider} from './working-view.js';
import {clearWorkingGraphics, drawWorkingGraphics, graphicsMode, logoFrame} from './working-graphics.js';

const base: TurnEntry = {requestId: 'r1', conversationId: 'root', participantId: 'p1', name: 'claude', runtime: 'claude-code', state: 'answering', expiresAt: 2000};

test('claims do not imply work; declarations expire and completion removes them', () => {
    const view = new WorkingView();
    view.update({mode: 'parallel', entries: [base, {...base, requestId: 'r2', workingAt: 10, participantId: 'p2'}]});
    expect(view.active(100).map((entry) => entry.participantId)).toEqual(['p2']);
    expect(view.forMessage('root', 100)).toHaveLength(1);
    expect(view.active(2000)).toHaveLength(0);
    view.update({mode: 'parallel', entries: []});
    expect(view.active(100)).toHaveLength(0);
});

test('provider counts are per agent, even when an agent has multiple requests or shares a display name', () => {
    const view = new WorkingView();
    view.update({mode: 'parallel', entries: [{...base, workingAt: 10}, {...base, workingAt: 10, requestId: 'r2'}, {...base, workingAt: 20, requestId: 'r3', participantId: 'p2'}]});
    expect(view.groups(100)[0]).toMatchObject({provider: 'claude', count: 2});
    expect(logoProvider('codex-cli')).toBe('openai');
    expect(logoProvider('deepseek')).toBe('deepseek');
    expect(logoProvider()).toBe('other');
});

test('terminal selection has a safe fallback and an explicit override', () => {
    expect(graphicsMode({TERM_PROGRAM: 'Apple_Terminal'})).toBe('cells');
    expect(graphicsMode({TERM_PROGRAM: 'iTerm.app'})).toBe('iterm2');
    expect(graphicsMode({TERM_PROGRAM: 'ghostty'})).toBe('kitty');
    expect(graphicsMode({TERM_PROGRAM: 'WarpTerminal'})).toBe('cells');
    expect(graphicsMode({TERM_PROGRAM: 'ghostty', TMUX: 'session'})).toBe('cells');
    expect(graphicsMode({TERM_PROGRAM: 'ghostty', PAIRLOBBY_GRAPHICS: 'cells'})).toBe('cells');
});

test('logos are animated, bounded and framed with cursor preservation and scoped cleanup', () => {
    const placements = [{provider: 'claude' as const, row: 12, column: 3}];
    for (const provider of ['claude', 'openai', 'qwen', 'deepseek'] as const) {
        const frame = logoFrame(provider, 0)!;
        expect(frame.cells.split('\n').map((row) => Array.from(row).length)).toEqual([6, 6, 6]);
        expect(logoFrame(provider, 8)!.png).not.toBe(frame.png);
        expect(Buffer.from(frame.png, 'base64').subarray(1, 4).toString()).toBe('PNG');
    }
    expect(drawWorkingGraphics('cells', placements, 0)).toBe('');
    const iterm = drawWorkingGraphics('iterm2', placements, 0);
    expect(iterm).toContain('inline=1;width=6;height=3');
    expect(iterm.startsWith('\u001b7')).toBe(true);
    expect(iterm.endsWith('\u001b8')).toBe(true);
    expect(drawWorkingGraphics('kitty', placements, 0)).toContain('C=1,q=2');
    expect(clearWorkingGraphics('kitty', placements)).toContain('d=I,i=5262337');
    expect(clearWorkingGraphics('kitty', placements)).not.toContain('d=A');
});

import {EventEmitter} from 'node:events';
import {Writable} from 'node:stream';
import {afterEach, expect, test, vi} from 'vitest';
const mock = vi.hoisted(() => ({spawn: vi.fn()}));
vi.mock('node:child_process', () => ({spawn: mock.spawn}));
import {copyToClipboard} from './clipboard.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); mock.spawn.mockReset(); });

test('native clipboard receives the complete UTF-8 value on stdin, never as shell code', async () => {
    vi.stubEnv('SSH_TTY', '');
    vi.stubEnv('SSH_CONNECTION', '');
    const input: Buffer[] = [];
    mock.spawn.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {stdin: new Writable({write(chunk: Buffer, _encoding, done) { input.push(Buffer.from(chunk)); done(); }, final(done) { done(); queueMicrotask(() => child.emit('close', 0)); }}), kill: vi.fn()});
        return child;
    });
    const value = 'model-Ω $(do-not-execute)\nfull value';
    expect(await copyToClipboard(value)).toBe('Copied');
    expect(Buffer.concat(input).toString('utf8')).toBe(value);
    expect(JSON.stringify(mock.spawn.mock.calls)).not.toContain('do-not-execute');
    expect(mock.spawn.mock.calls[0]![2].shell).not.toBe(true);
});

test('SSH uses terminal clipboard output and does not claim confirmed copying', async () => {
    vi.stubEnv('SSH_CONNECTION', 'fixture');
    vi.stubEnv('TMUX', '');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const value = 'thread-Ω';
    expect(await copyToClipboard(value)).toContain('Copy request sent');
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from(value).toString('base64')}\x07`);
});

test('tmux clipboard passthrough escapes inner escape characters', async () => {
    vi.stubEnv('SSH_CONNECTION', 'fixture');
    vi.stubEnv('TMUX', 'fixture');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await copyToClipboard('hello');
    expect(write).toHaveBeenCalledWith('\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07\x1b\\');
});

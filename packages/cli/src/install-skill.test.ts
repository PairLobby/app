import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {installSkill} from './install-skill.js';
import {receiverRuntimeName} from './receiver-runtime.js';

const home = vi.hoisted(() => ({directory: ''}));
vi.mock('node:os', async (importOriginal) => ({...await importOriginal<typeof import('node:os')>(), homedir: () => home.directory}));

const originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];

beforeEach(() => {
    home.directory = mkdtempSync(join(tmpdir(), 'pairlobby-skills-'));
    delete process.env['XDG_CONFIG_HOME'];
});
afterEach(() => {
    rmSync(home.directory, {recursive: true, force: true});
    if (originalXdgConfigHome === undefined) {
        delete process.env['XDG_CONFIG_HOME'];
    } else {
        process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
    }
});

test('Qwen installs to its personal skills directory and preserves custom instructions', () => {
    const expected = join(home.directory, '.qwen', 'skills', 'pairlobby', 'SKILL.md');
    expect(installSkill('qwen')).toEqual([expected]);
    const bundled = readFileSync(expected, 'utf8');
    expect(bundled).toContain('name: pairlobby');
    expect(installSkill('qwen')).toEqual([expected]);
    writeFileSync(expected, 'Custom Qwen skill');
    expect(() => installSkill('qwen')).toThrow('different skill already exists');
    expect(readFileSync(expected, 'utf8')).toBe('Custom Qwen skill');
    installSkill('qwen', true);
    const backup = readdirSync(join(expected, '..')).find((name) => name.startsWith('SKILL.md.backup-'))!;
    expect(readFileSync(join(expected, '..', backup), 'utf8')).toBe('Custom Qwen skill');
    expect(readFileSync(expected, 'utf8')).toBe(bundled);
});

test('Qwen accepts a project skill directory and rejects ambiguous or invalid targets', () => {
    const directory = join(home.directory, 'project', '.qwen', 'skills');
    expect(installSkill('qwen', false, directory)).toEqual([join(directory, 'pairlobby', 'SKILL.md')]);
    expect(() => installSkill('all', false, directory)).toThrow('one agent');
    expect(() => installSkill('unknown')).toThrow('qwen');
});

test('Cursor, Grok, and Muse install to their user skill directories', () => {
    expect(installSkill('cursor')).toEqual([join(home.directory, '.cursor', 'skills', 'pairlobby', 'SKILL.md')]);
    expect(installSkill('grok')).toEqual([join(home.directory, '.grok', 'skills', 'pairlobby', 'SKILL.md')]);
    expect(installSkill('muse')).toEqual([join(home.directory, '.config', 'muse', 'skills', 'pairlobby', 'SKILL.md')]);

    const xdgConfigHome = join(home.directory, 'xdg-config');
    process.env['XDG_CONFIG_HOME'] = xdgConfigHome;
    expect(installSkill('muse')).toEqual([join(xdgConfigHome, 'muse', 'skills', 'pairlobby', 'SKILL.md')]);
});

test('all installs the shared skill for every supported agent', () => {
    const installed = installSkill('all');
    expect(installed).toHaveLength(6);
    expect(installed).toContain(join(home.directory, '.cursor', 'skills', 'pairlobby', 'SKILL.md'));
    expect(installed).toContain(join(home.directory, '.grok', 'skills', 'pairlobby', 'SKILL.md'));
    expect(installed).toContain(join(home.directory, '.config', 'muse', 'skills', 'pairlobby', 'SKILL.md'));
});

test('all validates conflicting skills before writing any installation', () => {
    const target = join(home.directory, '.claude', 'skills', 'pairlobby');
    mkdirSync(target, {recursive: true});
    writeFileSync(join(target, 'SKILL.md'), 'Custom skill');
    expect(() => installSkill('all')).toThrow('different skill already exists');
    // Claude is first, so even a real CODEX_HOME cannot be touched by this failed preflight.
    expect(readdirSync(home.directory)).toEqual(['.claude']);
    expect(receiverRuntimeName('qwen')).toBe('qwen');
    expect(receiverRuntimeName('qwen-code')).toBe('qwen');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('./sync-docs.mjs', import.meta.url));

test('a generated website copy matches the CLI source and check mode detects drift without rewriting', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-docs-sync-'));
    const target = join(directory, 'src', 'docs', 'catalog.ts');
    mkdirSync(join(directory, 'src', 'docs'), {recursive: true});
    writeFileSync(target, '// old website copy\n');
    try {
        execFileSync(process.execPath, [script, directory]);
        execFileSync(process.execPath, [script, directory, '--check']);
        const generated = readFileSync(target, 'utf8');
        writeFileSync(target, generated.replaceAll('\n', '\r\n'));
        execFileSync(process.execPath, [script, directory, '--check']);
        const edited = generated + '\n// Independent edit must be refused.\n';
        writeFileSync(target, edited);
        assert.throws(() => execFileSync(process.execPath, [script, directory, '--check'], {stdio: 'pipe'}), /documentation differs/);
        assert.equal(readFileSync(target, 'utf8'), edited);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test('sync requires an explicit website checkout containing the existing catalog', () => {
    assert.throws(() => execFileSync(process.execPath, [script], {stdio: 'pipe'}), /Usage:/);
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-docs-missing-'));
    try {
        assert.throws(() => execFileSync(process.execPath, [script, directory], {stdio: 'pipe'}), /Expected an existing/);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

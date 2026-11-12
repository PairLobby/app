import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('./check-candidates.mjs', import.meta.url));

for (const flag of ['--write-locks', '--locks-only']) {
    test(`${flag} cannot write candidate checksums into release lockfiles`, () => {
        const directory = mkdtempSync(join(tmpdir(), 'pairlobby-candidate-lock-test-'));
        const projects = ['durable', 'hosted'].map((name) => join(directory, name));
        const original = '{"packages":{"node_modules/@pairlobby/sqlite":{"version":"0.33.0","integrity":"published-integrity"}}}\n';
        for (const project of projects) {
            mkdirSync(project);
            writeFileSync(join(project, 'package-lock.json'), original);
        }
        try {
            const result = spawnSync(process.execPath, [script, ...projects, flag], {cwd: directory, encoding: 'utf8', timeout: 5000});
            assert.equal(result.status, 1);
            assert.match(result.stderr, /Candidate checks no longer write release lockfiles/);
            for (const project of projects) {
                assert.equal(readFileSync(join(project, 'package-lock.json'), 'utf8'), original);
                assert.deepEqual(readdirSync(project), ['package-lock.json']);
            }
        } finally {
            rmSync(directory, {recursive: true, force: true});
        }
    });
}

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {checkCommitVersions, compareVersions} from './check-commit-versions.mjs';

function fixture(t) {
    const cwd = mkdtempSync(join(tmpdir(), 'pairlobby-version-policy-'));
    t.after(() => rmSync(cwd, {recursive: true, force: true}));
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Version policy test', '-c', 'user.email=version-test@example.invalid', ...args], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    git('init', '-b', 'test/version-policy');
    const commit = (version, subject) => {
        writeFileSync(join(cwd, 'ssmver.toml'), `version = "${version}"\n`);
        git('add', 'ssmver.toml');
        git('commit', '--allow-empty', '-m', subject);
        return git('rev-parse', 'HEAD');
    };
    return {cwd, git, commit, base: commit('1.0.0', 'chore: fixture base')};
}

test('every source commit must increase its version', (t) => {
    const {cwd, commit, base} = fixture(t);
    commit('1.0.1', 'fix: first');
    commit('1.0.2', 'chore: second');
    const head = commit('1.1.0', 'feature: third');
    assert.equal(checkCommitVersions(base, head, cwd), 3);
});

test('a later bump cannot hide an earlier missing bump', (t) => {
    const {cwd, commit, base} = fixture(t);
    const missed = commit('1.0.0', 'doc: forgot the bump');
    const head = commit('1.0.1', 'fix: later bump');
    assert.throws(() => checkCommitVersions(base, head, cwd), new RegExp(missed.slice(0, 12)));
});

test('downgrades and metadata-only changes are not bumps', (t) => {
    const {cwd, git, commit, base} = fixture(t);
    const lower = commit('0.9.9', 'fix: invalid downgrade');
    assert.throws(() => checkCommitVersions(base, lower, cwd), /must bump/);
    git('switch', '-c', 'test/metadata', base);
    const metadata = commit('1.0.0+build.2', 'build: metadata only');
    assert.throws(() => checkCommitVersions(base, metadata, cwd), /must bump its version above 1\.0\.0/);
});

test('semantic comparison respects numeric prereleases and stable releases', () => {
    assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
    assert.equal(compareVersions('1.0.0', '1.0.0-beta.10'), 1);
    assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.1'), 0);
    assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.2.1'), -1);
    assert.throws(() => compareVersions('1.0.0-beta.02', '1.0.0'), /Invalid/);
});

test('a branch must also advance beyond the current target branch version', (t) => {
    const {cwd, git, commit, base} = fixture(t);
    const head = commit('1.0.1', 'fix: source branch');
    git('switch', '-c', 'test/advanced-base', base);
    const advanced = commit('1.0.2', 'fix: target branch advanced');
    assert.throws(() => checkCommitVersions(advanced, head, cwd), /must be newer than the current base/);
});

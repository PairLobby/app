import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

function git(args, cwd) {
    return execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

function parsedVersion(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    const prerelease = match?.[4]?.split('.') ?? [];
    if (!match || prerelease.some((part) => !part || /^0\d+$/.test(part))) {
        throw new Error(`Invalid semantic version: ${value}`);
    }
    return {core: match.slice(1, 4).map(BigInt), prerelease};
}

export function compareVersions(left, right) {
    const a = parsedVersion(left);
    const b = parsedVersion(right);
    for (let index = 0; index < 3; index++) {
        if (a.core[index] !== b.core[index]) {
            return a.core[index] > b.core[index] ? 1 : -1;
        }
    }
    if (!a.prerelease.length || !b.prerelease.length) {
        return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
    }
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
        const first = a.prerelease[index];
        const second = b.prerelease[index];
        if (first === second) {
            continue;
        }
        if (first === undefined || second === undefined) {
            return first === undefined ? -1 : 1;
        }
        const firstNumeric = /^\d+$/.test(first);
        const secondNumeric = /^\d+$/.test(second);
        if (firstNumeric && secondNumeric) {
            return BigInt(first) > BigInt(second) ? 1 : -1;
        }
        return firstNumeric !== secondNumeric ? firstNumeric ? -1 : 1 : first > second ? 1 : -1;
    }
    return 0;
}

/** Inspect source commits, not GitHub's synthetic PR merge commit. */
export function checkCommitVersions(base, head, cwd = process.cwd()) {
    const commits = git(['rev-list', '--reverse', `${base}..${head}`], cwd).split('\n').filter(Boolean);
    const versions = new Map();
    function version(commit) {
        if (!versions.has(commit)) {
            const config = git(['show', `${commit}:ssmver.toml`], cwd);
            const value = /^version\s*=\s*"([^"]+)"/m.exec(config)?.[1];
            if (!value) {
                throw new Error(`No canonical version in commit ${commit.slice(0, 12)}`);
            }
            versions.set(commit, value);
        }
        return versions.get(commit);
    }
    for (const commit of commits) {
        const current = version(commit);
        const parents = git(['rev-list', '--parents', '-n', '1', commit], cwd).split(' ').slice(1);
        for (const parent of parents) {
            const previous = version(parent);
            if (compareVersions(current, previous) <= 0) {
                const subject = git(['show', '-s', '--format=%s', commit], cwd);
                throw new Error(`${commit.slice(0, 12)} (${subject}) must bump its version above ${previous}; found ${current}. Run ssmver update and use mode=all before committing.`);
            }
        }
    }
    if (commits.length && compareVersions(version(head), version(base)) <= 0) {
        throw new Error(`Source head ${version(head)} must be newer than the current base ${version(base)}. Refresh the branch version before merging.`);
    }
    return commits.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [base, head] = process.argv.slice(2);
        if (!base || !head) {
            throw new Error('Usage: node scripts/check-commit-versions.mjs <base-sha> <source-head-sha>');
        }
        console.log(`Verified version bumps in ${checkCommitVersions(base, head)} source commits.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

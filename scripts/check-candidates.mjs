#!/usr/bin/env node
// Build unpublished packages, test the neighboring checkouts against their exact tarballs, and restore installed dependencies.
// Release lockfiles are never changed: local package archives are not registry artifacts.
// Nothing is published. Run from any directory: node scripts/check-candidates.mjs ../durable-runtime ../worker
import {spawn} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = process.argv.slice(2);
if (paths.includes('--write-locks') || paths.includes('--locks-only')) {
    throw new Error('Candidate checks no longer write release lockfiles. Remove --write-locks/--locks-only to run the checks; refresh release lockfiles from npm only after the dependency versions are published.');
}
if (paths.length !== 2 || paths.some((path) => path.startsWith('--'))) {
    throw new Error('usage: check-candidates.mjs <durable-runtime> <worker>');
}
const [durable, hosted] = paths.map((path) => resolve(path));
const scratch = mkdtempSync(join(tmpdir(), 'pairlobby-candidates-'));
const packs = join(scratch, 'packs');
mkdirSync(packs);
const environment = {...process.env, PAIRLOBBY_DATA_DIR: join(scratch, 'device'), PAIRLOBBY_PORT: '0', PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_NO_NETWORK_SEARCH: '1', CLAUDE_CODE_SESSION_ID: '', WRANGLER_SEND_METRICS: 'false', CI: '1'};
const restored = [];
const artifacts = new Map();

function run(command, args, cwd) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(command, args, {cwd, env: environment, stdio: 'inherit'});
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`)));
    });
}

function replace(target) {
    const backup = join(scratch, `dependency-${restored.length}`);
    const present = existsSync(target) || (() => { try { return lstatSync(target).isSymbolicLink(); } catch { return false; } })();
    if (present) {
        renameSync(target, backup);
    }
    restored.push({target, backup: present ? backup : null});
    mkdirSync(dirname(target), {recursive: true});
}

async function discoverArtifacts() {
    for (const name of readdirSync(packs).filter((entry) => entry.endsWith('.tgz'))) {
        const folder = join(scratch, name.slice(0, -4));
        mkdirSync(folder);
        await run('tar', ['-xzf', join(packs, name), '-C', folder, '--strip-components=1'], root);
        const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
        artifacts.set(manifest.name, {manifest, tarball: name});
    }
}

try {
    await run(process.execPath, [join(root, 'scripts/publish-packages.mjs'), '--pack', packs], root);
    await run('npm', ['run', 'build'], durable);
    await run('npm', ['pack', '--ignore-scripts', '--pack-destination', packs], durable);
    await discoverArtifacts();
    for (const checkout of [durable, hosted]) {
        const names = [...artifacts.keys()].filter((name) => name !== '@pairlobby/durable-runtime' || checkout === hosted);
        for (const name of names) {
            replace(join(checkout, 'node_modules', name));
        }
        for (const name of names) {
            const target = join(checkout, 'node_modules', name);
            mkdirSync(target, {recursive: true});
            await run('tar', ['-xzf', join(packs, artifacts.get(name).tarball), '-C', target, '--strip-components=1'], root);
            for (const dependency of Object.keys(artifacts.get(name).manifest.dependencies ?? {}).filter((entry) => !entry.startsWith('@pairlobby/'))) {
                const source = join(root, 'node_modules', dependency);
                if (existsSync(source)) {
                    // Preserve each artifact's dependency major (notably Zod 3 beside the hosted app's Zod 4).
                    const nested = join(target, 'node_modules', dependency);
                    mkdirSync(dirname(nested), {recursive: true});
                    symlinkSync(source, nested, 'dir');
                }
            }
        }
    }
    await run('npm', ['test', '--', '--maxWorkers=1'], durable);
    await run('npm', ['run', 'typecheck'], hosted);
    await run('npm', ['test', '--', '--maxWorkers=1'], hosted);
    await run('npm', ['run', 'test:integration'], hosted);
    console.log('Candidate artifacts verified; release lockfiles are unchanged and dependency installations will now be restored.');
} finally {
    for (const {target, backup} of restored.reverse()) {
        rmSync(target, {recursive: true, force: true});
        if (backup) {
            renameSync(backup, target);
        }
    }
    rmSync(scratch, {recursive: true, force: true});
}

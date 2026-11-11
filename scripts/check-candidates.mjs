#!/usr/bin/env node
// Build unpublished packages, test the neighboring checkouts against their exact tarballs, and restore installed dependencies.
// Optional --write-locks resolves those same artifacts through a temporary local registry and records their future registry URLs.
// Nothing is published. Run from any directory: node scripts/check-candidates.mjs ../durable-runtime ../worker [--write-locks] [--locks-only]
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
if (paths.length !== 2) {
    throw new Error('usage: check-candidates.mjs <durable-runtime> <worker> [--write-locks] [--locks-only]');
}
const [durable, hosted] = paths.map((path) => resolve(path));
const scratch = mkdtempSync(join(tmpdir(), 'pairlobby-candidates-'));
const packs = join(scratch, 'packs');
mkdirSync(packs);
const environment = {...process.env, PAIRLOBBY_DATA_DIR: join(scratch, 'device'), PAIRLOBBY_PORT: '0', PAIRLOBBY_NO_UPDATE_CHECK: '1', PAIRLOBBY_NO_NETWORK_SEARCH: '1', CLAUDE_CODE_SESSION_ID: '', WRANGLER_SEND_METRICS: 'false', CI: '1'};
const restored = [];
const artifacts = new Map();
let registry;
let base;

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
        const bytes = readFileSync(join(packs, name));
        artifacts.set(manifest.name, {manifest, bytes, tarball: name, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex')});
    }
}

async function writeLocks(checkout) {
    const lock = join(checkout, 'package-lock.json');
    const previous = existsSync(lock) ? readFileSync(lock) : null;
    try {
        await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', base], checkout);
        const data = JSON.parse(readFileSync(lock, 'utf8'));
        for (const entry of Object.values(data.packages)) {
            if (entry.resolved?.startsWith(base)) {
                const artifact = [...artifacts.values()].find((candidate) => entry.resolved.endsWith(`/${candidate.tarball}`));
                if (!artifact || entry.integrity !== artifact.integrity) {
                    throw new Error('lock resolution did not match a built candidate artifact');
                }
                entry.resolved = `https://registry.npmjs.org/${artifact.manifest.name}/-/${basename(artifact.manifest.name)}-${artifact.manifest.version}.tgz`;
            }
        }
        writeFileSync(lock, `${JSON.stringify(data, null, 2)}\n`);
    } catch (error) {
        if (previous) {
            writeFileSync(lock, previous);
        } else {
            rmSync(lock, {force: true});
        }
        throw error;
    }
}

try {
    await run(process.execPath, [join(root, 'scripts/publish-packages.mjs'), '--pack', packs], root);
    await run('npm', ['run', 'build'], durable);
    await run('npm', ['pack', '--ignore-scripts', '--pack-destination', packs], durable);
    await discoverArtifacts();
    registry = createServer(async (request, response) => {
        try {
            const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
            const artifact = artifacts.get(path);
            if (artifact) {
                const manifest = {...artifact.manifest, dist: {tarball: `${base}tarballs/${artifact.tarball}`, integrity: artifact.integrity, shasum: artifact.shasum}};
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({name: manifest.name, 'dist-tags': {latest: manifest.version}, versions: {[manifest.version]: manifest}}));
            } else if (path.startsWith('tarballs/')) {
                const packed = [...artifacts.values()].find((entry) => path === `tarballs/${entry.tarball}`);
                response.writeHead(packed ? 200 : 404);
                response.end(packed?.bytes);
            } else {
                const upstream = await fetch(`https://registry.npmjs.org/${request.url.slice(1)}`, {headers: {accept: 'application/json'}});
                response.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type') ?? 'application/json'});
                response.end(Buffer.from(await upstream.arrayBuffer()));
            }
        } catch {
            response.writeHead(502);
            response.end('candidate registry request failed');
        }
    });
    await new Promise((ready) => registry.listen(0, '127.0.0.1', ready));
    base = `http://127.0.0.1:${registry.address().port}/`;
    for (const checkout of [durable, hosted]) {
        const names = [...artifacts.keys()].filter((name) => name !== '@pairlobby/durable-runtime' || checkout === hosted);
        for (const name of names) {
            replace(join(checkout, 'node_modules', name));
        }
        if (process.argv.includes('--write-locks')) {
            await writeLocks(checkout);
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
    if (!process.argv.includes('--locks-only')) {
        await run('npm', ['test', '--', '--maxWorkers=1'], durable);
        await run('npm', ['run', 'typecheck'], hosted);
        await run('npm', ['test', '--', '--maxWorkers=1'], hosted);
        await run('npm', ['run', 'test:integration'], hosted);
    }
    console.log(process.argv.includes('--locks-only') ? 'Candidate lockfiles resolved from built tarballs; integration checks were not requested.' : 'Candidate artifacts verified; dependency installations will now be restored.');
} finally {
    if (registry?.listening) {
        await new Promise((closed) => registry.close(closed));
    }
    for (const {target, backup} of restored.reverse()) {
        rmSync(target, {recursive: true, force: true});
        if (backup) {
            renameSync(backup, target);
        }
    }
    rmSync(scratch, {recursive: true, force: true});
}

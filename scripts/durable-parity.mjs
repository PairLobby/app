#!/usr/bin/env node
// Runs the shared relay checks (@pairlobby/conformance) against the Durable Object relay
// built from THIS checkout's packages, beside the Node relay, and prints one parity table.
//
//   node scripts/durable-parity.mjs <durable-runtime checkout> [--install] [--parity FILE]
//
// Use the adapter revision pinned in CI. --install bootstraps its locked external tooling
// in disposable storage, without fetching unpublished @pairlobby dependencies. Without
// --install, use the checkout's existing dependencies. Both modes overlay this app's exact
// package tarballs, run the open and token-guarded relays, and restore the prior installation.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {installParityDependencies} from './parity-dependencies.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const durable = process.argv[2] ? resolve(process.argv[2]) : null;
const parityFile = process.argv.includes('--parity') ? resolve(process.argv[process.argv.indexOf('--parity') + 1] ?? '') : null;
// The create token tests/token.wrangler.jsonc in durable-runtime sets for its relay.
const DURABLE_TEST_TOKEN = 'test-create-token';

if (!durable) {
    console.error('usage: node scripts/durable-parity.mjs <durable-runtime checkout> [--install] [--parity FILE]');
    process.exit(2);
}

const packs = mkdtempSync(join(tmpdir(), 'pairlobby-packs-'));
const data = mkdtempSync(join(tmpdir(), 'pairlobby-parity-'));
const harnesses = [];
const restored = [];
let removeToolingLink = () => {};
let node;
try {
    if (process.argv.includes('--install')) {
        removeToolingLink = installParityDependencies(durable, join(data, 'tooling'));
    }
    execFileSync(process.execPath, [join(root, 'scripts', 'publish-packages.mjs'), '--pack', packs], {cwd: root, stdio: ['ignore', 'ignore', 'inherit']});
    // Unpacked rather than `npm install`ed: npm 10 fails on a set of local tarballs that depend on
    // each other ("Cannot read properties of null (reading 'edgesOut')"). External runtime
    // dependencies come from this app's install, preserving the versions used to build its packages.
    for (const tarball of readdirSync(packs).filter((name) => name.endsWith('.tgz'))) {
        const target = join(durable, 'node_modules', '@pairlobby', tarball.replace(/^pairlobby-/, '').replace(/-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/, ''));
        const backup = existsSync(target) ? join(packs, `installed-${restored.length}`) : null;
        if (backup) {
            renameSync(target, backup);
        }
        restored.push({target, backup});
        mkdirSync(target, {recursive: true});
        execFileSync('tar', ['-xzf', join(packs, tarball), '-C', target, '--strip-components=1']);
        const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
        for (const dependency of Object.keys(manifest.dependencies ?? {}).filter((name) => !name.startsWith('@pairlobby/'))) {
            const source = join(root, 'node_modules', dependency);
            if (existsSync(source)) {
                const nested = join(target, 'node_modules', dependency);
                mkdirSync(dirname(nested), {recursive: true});
                symlinkSync(source, nested, 'dir');
            }
        }
    }

    const {createTestHarness} = await import(pathToFileURL(createRequire(join(durable, 'package.json')).resolve('wrangler')).href);
    const {parityMatrix, runConformance} = await import(pathToFileURL(join(root, 'packages', 'conformance', 'dist', 'index.js')).href);
    const {startServer} = await import(pathToFileURL(join(root, 'packages', 'local-server', 'dist', 'index.js')).href);

    const testLimits = {PAIRLOBBY_LIMIT_CREATE_PER_MIN_IP: '1000', PAIRLOBBY_LIMIT_REDEEM_PER_MIN_IP: '1000'};
    const open = createTestHarness({workers: [{configPath: join(durable, 'wrangler.jsonc'), vars: testLimits}]});
    const guarded = createTestHarness({workers: [{configPath: join(durable, 'tests', 'token.wrangler.jsonc'), vars: testLimits}]});
    harnesses.push(open, guarded);
    const [openUrl, guardedUrl] = (await Promise.all([open.listen(), guarded.listen()])).map((listening) => listening.url.toString());
    node = await startServer({port: 0, dataFile: join(data, 'rooms.sqlite'), createToken: DURABLE_TEST_TOKEN});

    const reports = {
        node: await runConformance({relay: node.url, createToken: DURABLE_TEST_TOKEN}),
        durable: await runConformance({relay: openUrl}),
        'durable with create token': await runConformance({relay: guardedUrl, createToken: DURABLE_TEST_TOKEN})
    };
    const matrix = parityMatrix(reports);
    process.stdout.write(`${matrix}\n`);
    if (parityFile) {
        writeFileSync(parityFile, `${matrix}\n`);
    }
    process.exitCode = Object.values(reports).every((report) => report.passed) ? 0 : 1;
} finally {
    await Promise.allSettled([...harnesses.map((harness) => harness.close()), node?.close()]);
    for (const {target, backup} of restored.reverse()) {
        rmSync(target, {recursive: true, force: true});
        if (backup) {
            renameSync(backup, target);
        }
    }
    removeToolingLink();
    rmSync(packs, {recursive: true, force: true});
    rmSync(data, {recursive: true, force: true});
}

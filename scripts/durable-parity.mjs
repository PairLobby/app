#!/usr/bin/env node
// Runs the shared relay checks (@pairlobby/conformance) against the Durable Object relay
// built from THIS checkout's packages, beside the Node relay, and prints one parity table.
//
//   node scripts/durable-parity.mjs <durable-runtime checkout> [--parity FILE]
//
// The durable-runtime checkout needs `npm ci` done. This packs the workspace packages the
// way they would be published, installs them over the checkout's own (without saving), and
// runs its relay under wrangler's test harness, once open and once with its test create
// token. Build the workspace first (`npm run build`). Exits 1 when any check fails on either relay.
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const durable = process.argv[2] ? resolve(process.argv[2]) : null;
const parityFile = process.argv.includes('--parity') ? resolve(process.argv[process.argv.indexOf('--parity') + 1] ?? '') : null;
// The create token tests/token.wrangler.jsonc in durable-runtime sets for its relay.
const DURABLE_TEST_TOKEN = 'test-create-token';

if (!durable) {
    console.error('usage: node scripts/durable-parity.mjs <durable-runtime checkout> [--parity FILE]');
    process.exit(2);
}

const packs = mkdtempSync(join(tmpdir(), 'pairlobby-packs-'));
const data = mkdtempSync(join(tmpdir(), 'pairlobby-parity-'));
const harnesses = [];
let node;
try {
    execFileSync(process.execPath, [join(root, 'scripts', 'publish-packages.mjs'), '--pack', packs], {cwd: root, stdio: ['ignore', 'ignore', 'inherit']});
    const tarballs = readdirSync(packs).filter((name) => name.endsWith('.tgz')).map((name) => join(packs, name));
    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', ...tarballs], {cwd: durable, stdio: ['ignore', 'ignore', 'inherit']});

    const {createTestHarness} = await import(pathToFileURL(createRequire(join(durable, 'package.json')).resolve('wrangler')).href);
    const {parityMatrix, runConformance} = await import(pathToFileURL(join(root, 'packages', 'conformance', 'dist', 'index.js')).href);
    const {startServer} = await import(pathToFileURL(join(root, 'packages', 'local-server', 'dist', 'index.js')).href);

    const open = createTestHarness({workers: [{configPath: join(durable, 'wrangler.jsonc')}]});
    const guarded = createTestHarness({workers: [{configPath: join(durable, 'tests', 'token.wrangler.jsonc')}]});
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
    await Promise.all(harnesses.map((harness) => harness.close()));
    await node?.close();
    rmSync(packs, {recursive: true, force: true});
    rmSync(data, {recursive: true, force: true});
}

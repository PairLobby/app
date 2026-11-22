#!/usr/bin/env node
// Runs the same visibility fixture through Node and local DO SQLite without overlaying
// dependencies or writing anything in the other agent's durable-runtime checkout.
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
import {SqliteRoomStore} from '../packages/local-server/dist/sqlite-store.js';
import {VISIBLE_FILE_SQL} from '../packages/sqlite/dist/index.js';
import {seedVisibility, probeVisibility} from './lib/file-visibility-probe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tooling = resolve(process.argv.find((value) => value.startsWith('--tooling='))?.slice('--tooling='.length) ?? join(root, '../worker'));
const scratch = mkdtempSync(join(tmpdir(), 'pairlobby-file-visibility-'));
process.env.PAIRLOBBY_DATA_DIR = scratch;
process.env.WRANGLER_SEND_METRICS = 'false';
let harness;
const reports = [];
try {
    for (const large of [false, true]) {
        const path = join(scratch, `node-${large}.sqlite`);
        const store = new SqliteRoomStore(path);
        const db = new DatabaseSync(path);
        try {
            db.exec('BEGIN');
            const fixture = seedVisibility((query, ...values) => db.prepare(query).run(...values), large);
            db.exec('COMMIT');
            const started = performance.now();
            const result = await probeVisibility(store, (query) => db.prepare(query).all(), VISIBLE_FILE_SQL, fixture);
            reports.push({runtime: 'node', ...result, elapsedMs: Math.round((performance.now() - started) * 100) / 100});
        } finally {
            db.close();
            store.close();
        }
    }
    if (!process.argv.includes('--node-only')) {
        const require = createRequire(join(tooling, 'package.json'));
        const {createTestHarness} = await import(pathToFileURL(require.resolve('wrangler')).href);
        const alias = Object.fromEntries(['protocol', 'room-core', 'server-core', 'sqlite'].map((name) => [`@pairlobby/${name}`, join(root, `packages/${name}/dist/index.js`)]));
        alias['@pairlobby/durable-runtime'] = require.resolve('@pairlobby/durable-runtime');
        const entry = join(scratch, 'store.mjs');
        await build({stdin: {contents: `
            import {DurableObject} from 'cloudflare:workers';
            import {DurableRoomStore} from '@pairlobby/durable-runtime';
            import {VISIBLE_FILE_SQL} from '@pairlobby/sqlite';
            import {seedVisibility,probeVisibility} from ${JSON.stringify(join(root, 'scripts/lib/file-visibility-probe.mjs'))};
            export class VisibilityStore extends DurableObject {
                store = new DurableRoomStore(this.ctx.storage);
                async probe(large) {
                    const sql=this.ctx.storage.sql;
                    const fixture=this.ctx.storage.transactionSync(()=>seedVisibility((query,...values)=>sql.exec(query,...values),large));
                    const report=await probeVisibility(this.store,(query)=>sql.exec(query).toArray(),VISIBLE_FILE_SQL,fixture);
                    const measured=sql.exec('SELECT sum(size) AS bytes FROM files WHERE '+VISIBLE_FILE_SQL);
                    const bytes=measured.one().bytes;
                    return {...report,bytes,rowsRead:measured.rowsRead};
                }
            }
            export default {fetch(){return new Response('local visibility fixture')}};
        `, resolveDir: tooling, loader: 'js'}, outfile: entry, bundle: true, format: 'esm', platform: 'browser', alias, external: ['cloudflare:workers', 'node:*'], logLevel: 'silent'});
        const config = join(scratch, 'wrangler.jsonc');
        writeFileSync(config, JSON.stringify({name: 'pairlobby-visibility-test', account_id: 'a633403707f87dbc5de9aac0e55d5b99', main: entry, compatibility_date: '2026-09-14', compatibility_flags: ['nodejs_compat'], durable_objects: {bindings: [{name: 'STORES', class_name: 'VisibilityStore'}]}, migrations: [{tag: 'v1', new_sqlite_classes: ['VisibilityStore']}]}));
        harness = createTestHarness({workers: [{configPath: config}]});
        await harness.listen();
        const env = await harness.getWorker().getEnv();
        for (const large of [false, true]) {
            const result = await env.STORES.getByName(`visibility-${large}`).probe(large);
            if (result.rowsRead > result.files * 8 + 100) {
                throw new Error(`Visibility read amplification is unbounded: ${result.rowsRead} rows for ${result.files} files`);
            }
            reports.push({runtime: 'durable-object', ...result});
        }
    }
    process.stdout.write(JSON.stringify({passed: true, reports}) + '\n');
} finally {
    await harness?.close();
    if (existsSync(scratch)) {
        rmSync(scratch, {recursive: true, force: true});
    }
}

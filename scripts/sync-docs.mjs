#!/usr/bin/env node
// The CLI owns the catalog; a website checkout receives the exact same public data.
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const locations = args.filter((argument) => argument !== '--check');
if (locations.length !== 1 || locations[0].startsWith('--')) {
    throw new Error('Usage: node scripts/sync-docs.mjs <frontend-checkout> [--check]');
}
const source = readFileSync(resolve(root, 'packages/cli/src/docs/catalog.ts'), 'utf8').replace(/\r\n/g, '\n');
const hash = createHash('sha256').update(source).digest('hex');
const generated = `// Generated from PairLobby/app packages/cli/src/docs/catalog.ts. Do not edit this copy.\n// Source SHA-256: ${hash}\n// Sync: node ../app/scripts/sync-docs.mjs .\n\n${source}`;
const target = resolve(locations[0], 'src/docs/catalog.ts');
if (!existsSync(target)) {
    throw new Error(`Expected an existing PairLobby website catalog at ${target}`);
}
if (check) {
    if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== generated) {
        throw new Error('Website documentation differs from the CLI catalog. Run the sync command before releasing either checkout.');
    }
    console.log('Website and CLI documentation match.');
} else {
    writeFileSync(target, generated);
    console.log(`Updated ${target}`);
}

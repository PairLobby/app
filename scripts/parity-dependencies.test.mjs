import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {externalDependencies, installParityDependencies} from './parity-dependencies.mjs';

test('clean parity installation excludes unpublished app packages while retaining locked external versions', () => {
    const manifest = {
        name: '@pairlobby/durable-runtime', version: '0.5.0',
        dependencies: {'@pairlobby/sqlite': '0.33.0'},
        devDependencies: {'@pairlobby/fixtures': '0.33.0', wrangler: '4.131.2'},
        scripts: {prepare: 'must not run before candidate packages are installed'}
    };
    const lock = {lockfileVersion: 3, name: manifest.name, version: manifest.version, packages: {
        '': {...manifest},
        'node_modules/@pairlobby/sqlite': {version: '0.33.0', resolved: 'https://registry.example/unpublished'},
        'node_modules/@pairlobby/fixtures': {version: '0.33.0'},
        'node_modules/@pairlobby/protocol/node_modules/zod': {version: '3.25.76'},
        'node_modules/wrangler': {version: '4.131.2', integrity: 'locked-integrity', dependencies: {esbuild: '0.28.1'}},
        'node_modules/esbuild': {version: '0.28.1'}
    }};
    const originals = structuredClone({manifest, lock});
    const result = externalDependencies(manifest, lock);
    assert.deepEqual(result.manifest.dependencies, {});
    assert.deepEqual(result.manifest.devDependencies, {wrangler: '4.131.2'});
    assert.equal(result.manifest.scripts, undefined);
    assert.deepEqual(result.lock.packages['node_modules/wrangler'], lock.packages['node_modules/wrangler']);
    assert.deepEqual(Object.keys(result.lock.packages), ['', 'node_modules/wrangler', 'node_modules/esbuild']);
    assert.deepEqual(result.lock.packages[''], result.manifest);
    assert.deepEqual({manifest, lock}, originals);
});

test('install mode refuses to replace an existing local dependency installation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-parity-install-test-'));
    const modules = join(directory, 'node_modules');
    mkdirSync(modules);
    writeFileSync(join(modules, 'preserved'), 'local dependency');
    try {
        assert.throws(() => installParityDependencies(directory, join(directory, 'tooling')), /clean adapter checkout/);
        assert.equal(readFileSync(join(modules, 'preserved'), 'utf8'), 'local dependency');
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

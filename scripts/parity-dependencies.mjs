import {execFileSync} from 'node:child_process';
import {lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** Keep the adapter's locked external tools; candidate @pairlobby packages are supplied by the parity runner. */
export function externalDependencies(sourceManifest, sourceLock) {
    const manifest = {name: 'pairlobby-parity-tooling', version: '0.0.0', private: true};
    for (const field of dependencyFields) {
        if (sourceManifest[field]) {
            manifest[field] = Object.fromEntries(Object.entries(sourceManifest[field]).filter(([name]) => !name.startsWith('@pairlobby/')));
        }
    }
    if (sourceManifest.engines) {
        manifest.engines = {...sourceManifest.engines};
    }
    const lock = structuredClone(sourceLock);
    if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
        throw new Error('parity tooling requires an npm v3 package lock');
    }
    lock.name = manifest.name;
    lock.version = manifest.version;
    lock.packages[''] = {...manifest};
    for (const path of Object.keys(lock.packages)) {
        if (/(^|\/)node_modules\/@pairlobby\//.test(path)) {
            delete lock.packages[path];
        }
    }
    return {manifest, lock};
}

/** Install in disposable storage, without changing either checked-in manifest or replacing a local dependency installation. */
export function installParityDependencies(durable, tooling) {
    const modules = join(durable, 'node_modules');
    if (lstatSync(modules, {throwIfNoEntry: false})) {
        throw new Error('--install needs a clean adapter checkout without node_modules; omit it to use an existing installation');
    }
    const {manifest, lock} = externalDependencies(
        JSON.parse(readFileSync(join(durable, 'package.json'), 'utf8')),
        JSON.parse(readFileSync(join(durable, 'package-lock.json'), 'utf8'))
    );
    mkdirSync(tooling, {recursive: true});
    writeFileSync(join(tooling, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(tooling, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: tooling, stdio: 'inherit'});
    symlinkSync(join(tooling, 'node_modules'), modules, 'dir');
    return () => unlinkSync(modules);
}

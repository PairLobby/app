#!/usr/bin/env node
// Publishes the shared @pairlobby packages to npm, so other repositories can depend
// on them instead of vendoring: protocol, room-core, server-core, client, fixtures.
//
//   node scripts/publish-packages.mjs            # dry run: builds, stages and shows what would be published
//   node scripts/publish-packages.mjs --pack DIR # write the exact tarballs to DIR, to inspect or install
//   node scripts/publish-packages.mjs --missing  # list the packages npm does not have at this version, and stop
//   node scripts/publish-packages.mjs --publish  # really publish, in dependency order
//
// The version is the one ssmver keeps in ssmver.toml and writes into every package.json
// in lockstep. Nothing here chooses a version: a package that disagrees with ssmver.toml
// stops the run. Publishing skips whatever npm already has, so a run that failed halfway
// is finished by running it again, and the release workflow can call it on every merge.
//
// The package.json files in this repository stay `private` with `*` ranges, which is
// what a workspace wants and makes an accidental `npm publish` impossible. This stages
// a copy of each package for the registry: not private, internal dependencies pinned to
// the exact version being published, only built output, with the license beside it.
// Tests compiled into dist/ are left out.
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Dependency order: each package only depends on those before it.
const PACKAGES = ['packages/protocol', 'packages/room-core', 'packages/server-core', 'packages/client', 'fixtures'];
const publish = process.argv.includes('--publish');
const listMissing = process.argv.includes('--missing');
const packTo = process.argv.includes('--pack') ? resolve(process.argv[process.argv.indexOf('--pack') + 1] ?? '') : null;
const version = ssmverVersion();

function run(command, args, cwd) {
    return execFileSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']});
}

function ssmverVersion() {
    const found = /^version = "([^"]+)"$/m.exec(readFileSync(join(root, 'ssmver.toml'), 'utf8'));
    if (!found) {
        throw new Error('ssmver.toml has no version');
    }
    return found[1];
}

function readManifest(relativePath) {
    const manifest = JSON.parse(readFileSync(join(root, relativePath, 'package.json'), 'utf8'));
    if (manifest.version !== version) {
        throw new Error(`${manifest.name} is at ${manifest.version}, ssmver.toml is at ${version}; let ssmver bump them together`);
    }
    return manifest;
}

/** Whether npm already has this package at this version. Anything but a clear "not found" is an error, not a no. */
function isPublished(name) {
    try {
        return execFileSync('npm', ['view', `${name}@${version}`, 'version', '--registry', 'https://registry.npmjs.org'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim() === version;
    } catch (error) {
        if (String(error.stderr).includes('E404')) {
            return false;
        }
        throw new Error(`could not ask npm about ${name}@${version}: ${String(error.stderr).trim()}`);
    }
}

function copyBuilt(from, to) {
    mkdirSync(to, {recursive: true});
    for (const entry of readdirSync(from)) {
        const source = join(from, entry);
        if (statSync(source).isDirectory()) {
            copyBuilt(source, join(to, entry));
        } else if (!/\.test\.(js|d\.ts)(\.map)?$/.test(entry) && !entry.endsWith('.tsbuildinfo')) {
            cpSync(source, join(to, entry));
        }
    }
}

function stage(relativePath, outRoot) {
    const source = join(root, relativePath);
    const manifest = readManifest(relativePath);
    if (!existsSync(join(source, 'dist'))) {
        throw new Error(`${relativePath} has no dist/; run npm run build`);
    }
    const target = join(outRoot, manifest.name.replace('/', '__'));
    copyBuilt(join(source, 'dist'), join(target, 'dist'));
    cpSync(join(root, 'LICENSE'), join(target, 'LICENSE'));
    const pinned = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([name, range]) => [name, name.startsWith('@pairlobby/') ? version : range]));
    const staged = {
        name: manifest.name,
        version,
        description: manifest.description ?? `PairLobby ${manifest.name.split('/')[1]}: part of the PairLobby room protocol and relay`,
        license: 'Elastic-2.0',
        type: manifest.type,
        main: manifest.main,
        types: manifest.types,
        exports: manifest.exports,
        files: ['dist', 'LICENSE', 'README.md'],
        repository: {type: 'git', url: 'git+https://github.com/PairLobby/app.git', directory: relativePath},
        homepage: 'https://pairlobby.com',
        engines: {node: '>=22'},
        publishConfig: {access: 'public'},
        ...(Object.keys(pinned).length ? {dependencies: pinned} : {}),
        // The contract suites in fixtures run inside the consumer's own vitest.
        ...(manifest.peerDependencies ? {peerDependencies: manifest.peerDependencies} : {})
    };
    writeFileSync(join(target, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`);
    writeFileSync(join(target, 'README.md'), `# ${manifest.name}\n\nPart of [PairLobby](https://github.com/PairLobby/app), built from \`${relativePath}\` at version ${version}. See that repository for documentation.\n\nLicensed under the [Elastic License 2.0](LICENSE): you may use, copy, modify and distribute it, but may not offer it to others as a hosted or managed service.\n`);
    return {name: manifest.name, target};
}

if (listMissing) {
    for (const relativePath of PACKAGES) {
        const {name} = readManifest(relativePath);
        if (!isPublished(name)) {
            console.log(name);
        }
    }
    process.exit(0);
}

console.log(`building ${version}`);
run('npm', ['run', 'build', '--silent'], root);
const outRoot = mkdtempSync(join(tmpdir(), 'pairlobby-publish-'));
// A prerelease (0.12.0-beta.1) must not become what a plain `npm install` gets.
const distTag = version.includes('-') ? 'next' : 'latest';
let skipped = 0;
try {
    for (const relativePath of PACKAGES) {
        const {name, target} = stage(relativePath, outRoot);
        if (publish) {
            if (isPublished(name)) {
                console.log(`${name}@${version} is already on npm; skipping`);
                skipped += 1;
                continue;
            }
            console.log(`publishing ${name}@${version}`);
            execFileSync('npm', ['publish', '--access', 'public', '--tag', distTag], {cwd: target, stdio: 'inherit'});
        } else if (packTo) {
            mkdirSync(packTo, {recursive: true});
            console.log(`packed ${run('npm', ['pack', '--pack-destination', packTo], target).trim()}`);
        } else {
            const [packed] = JSON.parse(run('npm', ['pack', '--dry-run', '--json'], target));
            console.log(`would publish ${packed.name}@${packed.version}: ${packed.entryCount} files, ${(packed.unpackedSize / 1024).toFixed(0)} KiB unpacked`);
        }
    }
    console.log(publish ? `published ${PACKAGES.length - skipped} packages at ${version}${skipped ? `, ${skipped} were already there` : ''}` : packTo ? `tarballs are in ${packTo}` : 'dry run only; add --publish to publish');
} finally {
    rmSync(outRoot, {recursive: true, force: true});
}

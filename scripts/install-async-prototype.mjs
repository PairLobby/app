import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = '# PairLobby local synthetic prototype launcher';
const launcher = join(homedir(), '.local/bin/pairlobby-prototype');

function quote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

if (process.platform === 'win32') {
    throw new Error('This local prototype installer currently supports macOS and Linux.');
}
if (existsSync(launcher) && !readFileSync(launcher, 'utf8').includes(marker)) {
    throw new Error(`Refusing to overwrite an unrelated file: ${launcher}`);
}

const python = execFileSync('which', ['python3'], {encoding: 'utf8'}).trim();
const codex = execFileSync('which', ['codex'], {encoding: 'utf8'}).trim();
execFileSync(python, ['-c', 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"']);
const codexVersion = execFileSync(codex, ['--version'], {encoding: 'utf8'}).trim();

const bundle = await build({
    absWorkingDir: root,
    entryPoints: ['scripts/async-local-relay.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    legalComments: 'inline',
    banner: {js: "import {createRequire as createPrototypeRequire} from 'node:module'; const require = createPrototypeRequire(import.meta.url);"}
});
const relay = bundle.outputFiles[0].contents;
const harness = readFileSync(join(root, 'scripts/test-async-local.py'));
const version = createHash('sha256').update(relay).update(harness).digest('hex').slice(0, 16);
const destination = join(homedir(), '.local/share/pairlobby/prototypes', version);
mkdirSync(join(destination, 'scripts'), {recursive: true, mode: 0o700});
writeFileSync(join(destination, 'scripts/async-local-relay.mjs'), relay);
writeFileSync(join(destination, 'scripts/test-async-local.py'), harness);
copyFileSync(join(root, 'docs/async-local-test.md'), join(destination, 'README.md'));
writeFileSync(join(destination, 'installation.json'), JSON.stringify({
    version,
    mode: 'synthetic-local-test',
    codexVersion,
    node: process.execPath,
    python,
    codex
}, null, 2) + '\n');

mkdirSync(dirname(launcher), {recursive: true});
const executableDirectories = [...new Set([dirname(process.execPath), dirname(codex)])].join(':');
writeFileSync(launcher, `#!/bin/sh\n${marker}\nexport PATH=${quote(executableDirectories)}:"$PATH"\nexec ${quote(python)} ${quote(join(destination, 'scripts/test-async-local.py'))} "$@"\n`, {mode: 0o755});
chmodSync(launcher, 0o755);
console.log(`Installed: ${launcher}\nSnapshot: ${destination}\nRun: pairlobby-prototype\nSynthetic local provider only; no real model work or background login service.`);

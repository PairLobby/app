// Install the actual CLI from this checkout without publishing or downloading a release.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const install = join(homedir(), '.local/share/pairlobby');
const launcher = join(homedir(), '.local/bin/pairlobby');
const version = '0.2.0-local.5';
const work = mkdtempSync(join(tmpdir(), 'pairlobby-local-install-'));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

try {
    if (process.platform === 'win32') {
        throw new Error('This local checkout installer currently supports macOS and Linux.');
    }
    if (existsSync(launcher) && !readFileSync(launcher, 'utf8').includes('PairLobby managed launcher')) {
        throw new Error('Refusing to replace an unrelated pairlobby launcher.');
    }
    execFileSync(process.execPath, [join(root, 'scripts/build-distribution.mjs'), work, version], {cwd: root, stdio: 'pipe'});
    const archive = join(work, `pairlobby-cli-${version}.tgz`);
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex').slice(0, 12);
    execFileSync('tar', ['-xzf', archive, '-C', work]);
    const release = join(install, 'releases', `${version}-${digest}`);
    mkdirSync(dirname(release), {recursive: true});
    if (!existsSync(release)) {
        renameSync(join(work, 'package'), release);
    }
    const cli = join(release, 'dist/main.mjs');
    execFileSync(process.execPath, [cli, '--help'], {stdio: 'pipe'});
    mkdirSync(dirname(launcher), {recursive: true});
    const backup = launcher + '.before-async';
    if (existsSync(launcher) && !existsSync(backup)) {
        copyFileSync(launcher, backup);
    }
    const staged = launcher + '.installing';
    writeFileSync(staged, `#!/bin/sh\n# PairLobby managed launcher\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, {mode: 0o755});
    chmodSync(staged, 0o755);
    renameSync(staged, launcher);
    console.log(`Replaced: ${launcher}\nRelease: ${release}\nPrevious launcher: ${backup}`);
} finally {
    rmSync(work, {recursive: true, force: true});
}

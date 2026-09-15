#!/usr/bin/env node
//! Dispatches `npm run service:*` to whichever mechanism the platform has.
//!
//! macOS gets a LaunchAgent, Windows a scheduled task. Both start the relay at
//! login and bring it back if it stops; neither needs administrator rights.

import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMANDS = ['install', 'uninstall', 'status', 'restart', 'logs'];

const command = process.argv[2] ?? 'status';
if (!COMMANDS.includes(command)) {
    process.stderr.write(`usage: npm run service -- {${COMMANDS.join('|')}}\n`);
    process.exit(2);
}

const runner = {
    darwin: () => ({file: 'bash', args: [join(HERE, 'relay-service.sh'), command]}),
    win32: () => ({file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'relay-service.ps1'), command]}),
}[process.platform];

if (!runner) {
    // Saying which platforms are covered beats a generic failure: on Linux the
    // equivalent is a systemd --user unit, which nobody has written yet.
    process.stderr.write(`No background-relay support for ${process.platform} yet — macOS and Windows only.\n`);
    process.stderr.write('Run the relay yourself with "pairlobby serve", or see the shell hook in the README.\n');
    process.exit(1);
}

const {file, args} = runner();
const result = spawnSync(file, args, {stdio: 'inherit'});
process.exit(result.status ?? 1);

#!/usr/bin/env node
//! Restores the executable bit on the CLI entry point after a build.
//!
//! tsc emits plain files, so a clean rebuild leaves `dist/main.js` at 0644 and
//! the linked `pairlobby` command fails with "permission denied" — after having
//! worked fine until the next clean build. Cheap to set every time, and it
//! removes a failure that looks like a broken install.

import {chmodSync, existsSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'cli', 'dist', 'main.js');

// Windows has no execute bit; chmod there is a no-op that would only confuse.
if (process.platform === 'win32') process.exit(0);
if (!existsSync(BIN)) process.exit(0);

const mode = statSync(BIN).mode & 0o777;
if ((mode & 0o111) !== 0o111) chmodSync(BIN, mode | 0o755);

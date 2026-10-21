#!/usr/bin/env node
//! Restores the executable bit on the command entry points (pairlobby, pairlobby-relay) after a build.
//!
//! tsc emits plain files, so a clean rebuild leaves `dist/main.js` at 0644 and
//! the linked `pairlobby` command fails with "permission denied" — after having
//! worked fine until the next clean build. Cheap to set every time, and it
//! removes a failure that looks like a broken install.

import {chmodSync, existsSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages');
const BINS = [join(PACKAGES, 'cli', 'dist', 'main.js'), join(PACKAGES, 'local-server', 'dist', 'relay-main.js')];

// Windows has no execute bit; chmod there is a no-op that would only confuse.
if (process.platform === 'win32') process.exit(0);

for (const bin of BINS) {
    if (!existsSync(bin)) continue;
    const mode = statSync(bin).mode & 0o777;
    if ((mode & 0o111) !== 0o111) chmodSync(bin, mode | 0o755);
}

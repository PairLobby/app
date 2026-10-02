//! The CLI's version, read from its own package.json: the file ssmver keeps in step
//! with ssmver.toml. Resolved from this module's location, so it works from the
//! checkout (src or dist), the bundled release, and an installed release folder.

import {readFileSync} from 'node:fs';

type PackageMetadata = {version: string};

export const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata).version;

#!/usr/bin/env node
//! Regenerates the Codex instructions from the Claude Code skill.
//!
//! Both runtimes must receive identical instructions. If the spike finds a
//! behavioural difference between them, that difference has to come from the
//! runtime rather than from one having been told something the other was not.

import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, 'claude-code', 'SKILL.md'), 'utf8');
const body = skill.split(/^---$/m).slice(2).join('---').trimStart();

const header = `<!--
Codex reads this file automatically. It is generated from
integrations/claude-code/SKILL.md so both runtimes get identical instructions —
a spike that finds a behavioural difference between them must be a difference in
the runtime, not in what each was told.

Regenerate with: node integrations/sync-instructions.mjs
-->

`;

writeFileSync(join(here, 'codex', 'AGENTS.md'), header + body);
process.stdout.write('wrote integrations/codex/AGENTS.md\n');

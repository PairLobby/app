#!/usr/bin/env node
//! `pairlobby-conformance <relay url> [--json] [--only id,id]`: runs the shared relay
//! checks against a running relay. The create token, when the relay needs one, comes
//! from PAIRLOBBY_CREATE_TOKEN so it never appears in a process list.

import {CHECKS, parityMatrix, runConformance} from './index.js';

const args = process.argv.slice(2);
const relay = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--only');
const only = args.includes('--only') ? (args[args.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : undefined;

if (!relay || args.includes('--help')) {
    process.stdout.write(`pairlobby-conformance <relay url> [--json] [--only id,id]\n\nChecks: ${CHECKS.map((check) => check.id).join(', ')}\nSet PAIRLOBBY_CREATE_TOKEN when the relay needs its create token.\n`);
    process.exit(relay ? 0 : 2);
}

const report = await runConformance({relay, createToken: process.env['PAIRLOBBY_CREATE_TOKEN'] || undefined, ...(only ? {only} : {})});
process.stdout.write(args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : `${parityMatrix({[report.relay]: report})}\n`);
process.exit(report.passed ? 0 : 1);

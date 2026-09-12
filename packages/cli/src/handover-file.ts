//! Reading and writing the handover document.
//!
//! Machine fields live in YAML frontmatter and the prose body stays opaque, so a
//! missing or malformed field is a validation error rather than a heading the
//! parser guessed at.

import {HandoverMetadata} from '@pairlobby/protocol';
import type {HandoverDocument} from '@pairlobby/protocol';
import {parse, stringify} from 'yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseHandoverFile(text: string): HandoverDocument {
    const match = FRONTMATTER.exec(text);
    if (!match) throw new Error('a handover file must begin with a YAML frontmatter block delimited by ---');
    let frontmatter: unknown;
    try {
        frontmatter = parse(match[1]!);
    } catch (error) {
        throw new Error(`the handover frontmatter is not valid YAML: ${(error as Error).message}`);
    }
    const metadata = HandoverMetadata.safeParse(frontmatter);
    if (!metadata.success) {
        const problems = metadata.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
        throw new Error(`the handover frontmatter is missing or malformed — ${problems}`);
    }
    return {metadata: metadata.data, body: (match[2] ?? '').trim()};
}

export function renderHandoverFile(document: HandoverDocument): string {
    return `---\n${stringify(document.metadata).trim()}\n---\n\n${document.body}\n`;
}

export const HANDOVER_TEMPLATE = `---
goal: What this handover is for, in one sentence
recipient: the display name of the agent taking over
mode: sequential
nextAction: The one concrete thing the recipient should do first
decisions:
  - A decision the recipient should not relitigate
blockers: []
repository:
  branch: main
  commit: "0000000"
  dirty: false
  missingPaths: []
tests:
  command: npm test
  result: not_run
---

Current state and completed work go here as prose. The receiving agent reads
this; PairLobby never summarizes it for you.
`;

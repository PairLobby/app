//! The handover document: machine-readable fields in YAML frontmatter, opaque
//! prose in the body. A missing or malformed field is a validation error, never
//! a heading the parser guessed at.

import {z} from 'zod';

export const HandoverMode = z.enum(['sequential', 'concurrent']);
export type HandoverMode = z.infer<typeof HandoverMode>;

export const TestResult = z.enum(['passed', 'failed', 'not_run']);
export type TestResult = z.infer<typeof TestResult>;

export const RepositoryRef = z.object({
    remote: z.string().min(1).max(512).optional(),
    branch: z.string().min(1).max(256),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/, 'expected a hex commit sha'),
    worktreePath: z.string().min(1).max(1024).optional(),
    dirty: z.boolean(),
    /** Paths the sender knows the receiver cannot reach yet. Flagged as missing until transferred. */
    missingPaths: z.array(z.string().min(1).max(1024)).max(100).default([]),
});
export type RepositoryRef = z.infer<typeof RepositoryRef>;

export const TestsRef = z.object({
    command: z.string().min(1).max(512),
    result: TestResult,
    notes: z.string().max(2048).optional(),
});
export type TestsRef = z.infer<typeof TestsRef>;

export const HandoverMetadata = z.object({
    goal: z.string().min(1).max(2048),
    recipient: z.string().min(1).max(128),
    mode: HandoverMode,
    nextAction: z.string().min(1).max(2048),
    decisions: z.array(z.string().min(1).max(1024)).max(50).default([]),
    blockers: z.array(z.string().min(1).max(1024)).max(50).default([]),
    repository: RepositoryRef.optional(),
    tests: TestsRef.optional(),
});
export type HandoverMetadata = z.infer<typeof HandoverMetadata>;

export const HandoverDocument = z.object({
    metadata: HandoverMetadata,
    /** Current state, completed work, and anything else the sender wrote as prose. */
    body: z.string().max(24 * 1024),
});
export type HandoverDocument = z.infer<typeof HandoverDocument>;

export const HandoverState = z.enum(['offered', 'accepted', 'declined']);
export type HandoverState = z.infer<typeof HandoverState>;

//! Files a managed agent sends with its answer. The agent names them while it
//! works; the receiver keeps the list beside the request and uploads them only
//! when it posts the answer, so a turn that fails or is interrupted sends nothing.

import {realpathSync, statSync} from 'node:fs';
import {basename, isAbsolute, relative, resolve, sep} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';

import {ABSOLUTE_MAX_FILE_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, formatFileSize} from '@pairlobby/protocol';
import type {Attachment} from '@pairlobby/protocol';

import {readOutgoingFile} from './files.js';
import type {FileContext} from './files.js';

export type AnswerFiles = {attachments: Attachment[]; problems: string[]};

function stagedKey(eventId: string): string {
    return `attach:${eventId}`;
}

/**
 * The real path of a file the agent may send: a regular, non-empty file inside its
 * workspace once every symbolic link is followed. Anything else is refused, so an
 * agent cannot be talked into sending a credential or a file from another project.
 */
export function answerFilePath(path: string, workdir: string): string {
    if (!path.trim()) {
        throw new Error('Name the file to attach.');
    }
    const root = realpathSync(workdir);
    let real: string;
    try {
        real = realpathSync(resolve(root, path));
    } catch {
        throw new Error(`No file at ${path}.`);
    }
    const inside = relative(root, real);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw new Error(`${path} is outside the workspace ${root}; only files inside it can be attached.`);
    }
    const stats = statSync(real);
    if (!stats.isFile()) {
        throw new Error(`${path} is not a file.`);
    }
    if (stats.size === 0) {
        throw new Error(`${path} is empty.`);
    }
    if (stats.size > ABSOLUTE_MAX_FILE_BYTES) {
        throw new Error(`${path} is ${formatFileSize(stats.size)}; a room accepts files up to ${formatFileSize(ABSOLUTE_MAX_FILE_BYTES)}.`);
    }
    return real;
}

/** The files named for this request so far, oldest first. */
export function stagedAnswerFiles(database: DatabaseSync, eventId: string): string[] {
    const value = database.prepare('SELECT value FROM metadata WHERE key=?').get(stagedKey(eventId))?.['value'];
    if (typeof value !== 'string') {
        return [];
    }
    try {
        const paths = JSON.parse(value) as unknown;
        return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
    } catch {
        return [];
    }
}

/** Adds a file to the answer of the request `eventId`, and says what the agent should know. */
export function stageAnswerFile(database: DatabaseSync, eventId: string, workdir: string, path: string): string {
    const real = answerFilePath(path, workdir);
    const staged = stagedAnswerFiles(database, eventId);
    if (staged.includes(real)) {
        return `${basename(real)} is already attached to this answer.`;
    }
    if (staged.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new Error(`An answer carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
    }
    database.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(stagedKey(eventId), JSON.stringify([...staged, real]));
    return `${basename(real)} will be sent with your final answer (${staged.length + 1} of at most ${MAX_ATTACHMENTS_PER_MESSAGE}). Mention it in the answer; do not paste its contents.`;
}

export function clearAnswerFiles(database: DatabaseSync, eventId: string): void {
    database.prepare('DELETE FROM metadata WHERE key=?').run(stagedKey(eventId));
}

/**
 * Uploads the staged files just before the answer is posted. A file that moved,
 * grew too large or was refused by the relay is left out and named in
 * `problems`, so the answer itself is never lost to a bad attachment.
 */
export async function uploadAnswerFiles(context: FileContext, paths: string[], workdir: string, filesSupported: boolean): Promise<AnswerFiles> {
    if (paths.length === 0) {
        return {attachments: [], problems: []};
    }
    if (!filesSupported) {
        return {attachments: [], problems: [`Files not sent (this relay does not store files): ${paths.map((path) => basename(path)).join(', ')}.`]};
    }
    const attachments: Attachment[] = [];
    const problems: string[] = [];
    for (const path of paths) {
        try {
            const file = readOutgoingFile(answerFilePath(path, workdir));
            attachments.push(await context.client.uploadFile(context.roomId, context.credential, file.name, file.bytes, file.mediaType));
        } catch (error) {
            problems.push(`Could not attach ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return {attachments, problems};
}

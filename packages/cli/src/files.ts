//! Files in a room, from this device's side: reading one to send, saving one that
//! arrived, and showing them. A received file is only ever written as plain data
//! under a new name; nothing here opens, runs or overwrites one.

import {closeSync, createReadStream, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync} from 'node:fs';
import {Readable} from 'node:stream';
import {homedir} from 'node:os';
import {basename, extname, join, resolve} from 'node:path';

import {MAX_ATTACHMENTS_PER_MESSAGE, ProtocolError, formatFileSize, safeFileName} from '@pairlobby/protocol';
import type {Attachment, FileUsage, RoomFile, RoomSnapshot} from '@pairlobby/protocol';
import type {PairLobbyClient} from '@pairlobby/client';

export type FileContext = {client: PairLobbyClient; roomId: string; credential: string};
export type OutgoingFile = {name: string; bytes: Uint8Array; mediaType: string};
export type OutgoingFileInfo = {name: string; path: string; size: number; mediaType: string};
type ReceivedFileHandle = {path: string; handle: number};
export type SavedFile = {file: Attachment; path: string};

/** The most text `/open` draws in the transcript; a longer file is cut and says so. */
const PREVIEW_BYTES = 64 * 1024;
/** Nothing larger is read into memory just to learn the relay will refuse it. */
const LOCAL_READ_LIMIT = 256 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.log': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml',
    '.toml': 'application/toml', '.xml': 'application/xml', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/x-typescript', '.py': 'text/x-python',
    '.rs': 'text/x-rust', '.sh': 'text/x-shellscript', '.diff': 'text/x-diff', '.patch': 'text/x-diff', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
};

export function mediaTypeFor(name: string): string {
    return MEDIA_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function expandPath(path: string, cwd = process.cwd()): string {
    const unquoted = path.replace(/^(['"])(.*)\1$/, '$2');
    return unquoted === '~' || unquoted.startsWith('~/') ? join(homedir(), unquoted.slice(1)) : resolve(cwd, unquoted);
}

export function readOutgoingFile(path: string, cwd = process.cwd()): OutgoingFile {
    const file = outgoingFileInfo(path, cwd);
    return {name: file.name, bytes: new Uint8Array(readFileSync(file.path)), mediaType: file.mediaType};
}

export function outgoingFileInfo(path: string, cwd = process.cwd()): OutgoingFileInfo {
    const location = expandPath(path, cwd);
    let size: number;
    try {
        const stats = statSync(location);
        if (!stats.isFile()) {
            throw new Error(`${path} is not a file`);
        }
        size = stats.size;
    } catch (error) {
        throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? `no file at ${path}` : error instanceof Error ? error.message : String(error));
    }
    if (size === 0) {
        throw new Error(`${path} is empty`);
    }
    if (size > LOCAL_READ_LIMIT) {
        throw new Error(`${path} is ${formatFileSize(size)}, far more than a room accepts`);
    }
    const handle = openSync(location, 'r');
    closeSync(handle);
    return {path: location, name: basename(location), size, mediaType: mediaTypeFor(location)};
}

export async function uploadOutgoingFile(context: FileContext, file: OutgoingFileInfo): Promise<Attachment> {
    const fd = openSync(file.path, 'r');
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size !== file.size) {
        closeSync(fd);
        throw new Error(`${file.name} changed before it could be uploaded; try again`);
    }
    const stream = createReadStream(file.path, {fd, highWaterMark: 64 * 1024, autoClose: true});
    try {
        return await context.client.uploadFileStream(context.roomId, context.credential, {name: file.name, size: file.size, mediaType: file.mediaType, body: Readable.toWeb(stream) as ReadableStream<Uint8Array>});
    } finally {
        stream.destroy();
    }
}

/** Checks every path before uploading any, then reads one file at a time with bounded memory. */
export async function uploadFiles(context: FileContext, paths: string[], snapshot: RoomSnapshot, cwd = process.cwd()): Promise<Attachment[]> {
    if (!snapshot.filesSupported) {
        throw new ProtocolError('unsupported_capability', 'This relay does not store files. Update it, or send the text instead.');
    }
    if (paths.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new Error(`A message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
    }
    const outgoing = paths.map((path) => outgoingFileInfo(path, cwd));
    const attachments: Attachment[] = [];
    for (const file of outgoing) {
        attachments.push(await uploadOutgoingFile(context, file));
    }
    return attachments;
}

export function attachmentLabel(file: Attachment): string {
    return `${file.name} · ${formatFileSize(file.size)}`;
}

/** What to say when a message is only files. */
export function attachmentText(files: Attachment[]): string {
    return files.length === 1 ? `Sent ${files[0]!.name}` : `Sent ${files.length} files`;
}

/**
 * Picks a file by its number in the room's list, its id, or its name. A name
 * shared by several files picks the newest, which is the one just talked about.
 */
export function findRoomFile(files: RoomFile[], reference: string): RoomFile {
    const wanted = reference.trim();
    const number = /^\d+$/.test(wanted) ? Number(wanted) : 0;
    const found = number >= 1 ? files[number - 1] : files.find((file) => file.fileId === wanted) ?? files.filter((file) => file.name.toLowerCase() === wanted.toLowerCase()).at(-1);
    if (!found) {
        throw new Error(files.length ? `No file ${wanted} in this room. /files lists them.` : 'No files have been sent in this room.');
    }
    return found;
}

/** "12 MB of 512 MB used · up to 95 MB per file". */
export function fileUsageLine(usage: FileUsage): string {
    return `${formatFileSize(usage.usedBytes)} of ${formatFileSize(usage.limitBytes)} used · up to ${formatFileSize(usage.maxFileBytes)} per file`;
}

export function filesReport(files: RoomFile[], names: Map<string, string>, usage?: FileUsage): string {
    const footer = usage ? `\n${fileUsageLine(usage)}` : '';
    if (files.length === 0) {
        return `No files have been sent in this room. Send one with /attach <path>.${footer}`;
    }
    const width = String(files.length).length;
    return files.map((file, index) => `${String(index + 1).padStart(width)}  ${attachmentLabel(file)} · from ${names.get(file.uploaderId) ?? file.uploaderId} · ${new Date(file.createdAt).toLocaleString()}`).join('\n') + footer;
}

/**
 * Writes a received file into `directory` under its own name, or the name with a
 * number when that is taken. Created exclusively, so an existing file is never
 * replaced, and without the executable bit whatever the file is.
 */
export function writeReceivedFile(directory: string, name: string, bytes: Uint8Array): string {
    const {path, handle} = openReceivedFile(directory, name);
    try {
        writeAll(handle, bytes);
    } catch (error) {
        unlinkSync(path);
        throw error;
    } finally {
        closeSync(handle);
    }
    return path;
}

function writeAll(handle: number, bytes: Uint8Array): void {
    for (let offset = 0; offset < bytes.byteLength;) {
        const written = writeSync(handle, bytes, offset, bytes.byteLength - offset);
        if (written === 0) {
            throw new Error('the file could not be written');
        }
        offset += written;
    }
}

function openReceivedFile(directory: string, name: string): ReceivedFileHandle {
    mkdirSync(directory, {recursive: true});
    const safe = safeFileName(name);
    const extension = extname(safe);
    const stem = extension ? safe.slice(0, -extension.length) : safe;
    for (let attempt = 0; attempt < 1000; attempt++) {
        const path = join(directory, attempt === 0 ? safe : `${stem} (${attempt})${extension}`);
        let handle: number;
        try {
            handle = openSync(path, 'wx', 0o644);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                continue;
            }
            throw error;
        }
        return {path, handle};
    }
    throw new Error(`Too many files named ${safe} in ${directory}.`);
}

export async function saveFile(context: FileContext, file: Attachment, directory: string): Promise<string> {
    const stream = await context.client.downloadFileStream(context.roomId, context.credential, file.fileId);
    const reader = stream.getReader();
    let output: ReceivedFileHandle | undefined;
    try {
        output = openReceivedFile(directory, file.name);
        for (;;) {
            const {done, value} = await reader.read();
            if (done) {
                break;
            }
            writeAll(output.handle, value);
        }
        return output.path;
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        if (output) {
            unlinkSync(output.path);
        }
        throw error;
    } finally {
        reader.releaseLock();
        if (output) {
            closeSync(output.handle);
        }
    }
}

/** Drain and verify the whole download, retaining just enough text for its preview. */
export async function downloadPreview(context: FileContext, file: Attachment): Promise<string> {
    const reader = (await context.client.downloadFileStream(context.roomId, context.credential, file.fileId)).getReader();
    const preview = new Uint8Array(Math.min(PREVIEW_BYTES, file.size));
    let used = 0;
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) {
                break;
            }
            const length = Math.min(value.byteLength, preview.byteLength - used);
            preview.set(value.subarray(0, length), used);
            used += length;
        }
        return previewFile(file, preview.subarray(0, used), file.size);
    } finally {
        reader.releaseLock();
    }
}

/**
 * Saves a message's files where an agent working in `workdir` can read them:
 * `<workdir>/.pairlobby/files/<message>/`. The folder ignores itself in git, so a
 * received file is not committed by accident.
 */
export async function saveForAgent(context: FileContext, files: Attachment[], workdir: string, eventId: string): Promise<SavedFile[]> {
    const root = join(workdir, '.pairlobby');
    const directory = join(root, 'files', eventId);
    mkdirSync(directory, {recursive: true});
    try {
        writeFileSync(join(root, '.gitignore'), '*\n', {flag: 'wx'});
    } catch {
        // Already there, or not writable; the files themselves matter more.
    }
    const saved: SavedFile[] = [];
    for (const file of files) {
        saved.push({file, path: await saveFile(context, file, directory)});
    }
    return saved;
}

/** Whether the bytes are text worth drawing: valid UTF-8 with no NUL. The declared type is not trusted for this. */
export function decodeText(bytes: Uint8Array): string | null {
    if (bytes.includes(0)) {
        return null;
    }
    try {
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
        return null;
    }
}

/** A file as Markdown for the transcript: a fenced block, labelled `json` when it is, cut at 64 KB. */
export function previewFile(file: Attachment, bytes: Uint8Array, totalBytes = bytes.byteLength): string {
    const shown = bytes.byteLength > PREVIEW_BYTES ? bytes.subarray(0, PREVIEW_BYTES) : bytes;
    // A cut may land inside a character; only then, drop up to three trailing bytes to find a clean end.
    const cutShort = shown.byteLength < totalBytes;
    let text: string | null = null;
    for (let trim = 0; trim < (cutShort ? 4 : 1) && text === null; trim++) {
        text = decodeText(shown.subarray(0, shown.byteLength - trim));
    }
    if (text === null) {
        return `${attachmentLabel(file)} is not text. Save it with /save ${file.name}.`;
    }
    const language = extname(file.name).toLowerCase() === '.json' ? 'json' : '';
    const fence = text.includes('```') ? '````' : '```';
    const cut = cutShort ? `\nShowing the first ${formatFileSize(PREVIEW_BYTES)} of ${formatFileSize(totalBytes)}. /save ${file.name} keeps all of it.` : '';
    return `**${file.name}** · ${formatFileSize(file.size)}\n${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}${cut}`;
}

export type AttachCommand = {paths: string[]; text: string};

/**
 * `/attach notes.txt "my file.json" here they are`: the leading words that name
 * existing files are the files, and the rest is the message. Quotes or a
 * backslash keep a space inside a path, as a terminal writes a dropped file.
 */
export function splitAttachCommand(argument: string, cwd = process.cwd()): AttachCommand {
    const paths: string[] = [];
    let rest = argument.trim();
    while (rest) {
        const token = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:\\.|\S)+))\s*/.exec(rest);
        if (!token) {
            break;
        }
        const path = token[1] !== undefined ? token[1].replace(/\\(.)/g, '$1') : token[2] ?? token[3]!.replace(/\\(.)/g, '$1');
        let isFile = false;
        try {
            isFile = statSync(expandPath(path, cwd)).isFile();
        } catch {
            // Not a file: this word starts the message.
        }
        // The first word is always meant as a file, so a mistyped path is reported rather than sent as text.
        if (!isFile && paths.length > 0) {
            break;
        }
        paths.push(path);
        rest = rest.slice(token[0].length);
        if (!isFile) {
            break;
        }
    }
    return {paths, text: rest.trim()};
}

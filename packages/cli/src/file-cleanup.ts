import {FileId, formatFileSize} from '@pairlobby/protocol';
import type {DeleteFileResponse, FileCleanupItem, RoomFile, StoredFile} from '@pairlobby/protocol';
import type {PairLobbyClient} from '@pairlobby/client';
import type {LocalStore} from '@pairlobby/client';
import {findRoomFile} from './files.js';
import {cleanupOnlineFiles, onlineStoredFiles} from './online.js';

export type FileCleanupContext = {client: PairLobbyClient; roomId: string; credential: string; files: RoomFile[]; command: string};
export type FileCleanupResult = {text: string; preview?: RoomFile; result?: DeleteFileResponse};

/** Names and list numbers are useful for previews. Confirmation always pins an immutable file ID. */
export async function deleteRoomFile(reference: string, confirmed: boolean, context: FileCleanupContext): Promise<FileCleanupResult> {
    if (!reference.trim()) {
        throw new Error(`Usage: ${context.command} <number, name or file id>. Review the preview before confirming.`);
    }
    if (!confirmed) {
        const file = findRoomFile(context.files, reference.replace(/^(["'])(.*)\1$/, '$2'));
        return {preview: file, text: `Delete ${file.name} (${formatFileSize(file.size)}) for everyone in this room?\nThe conversation and downloaded copies stay. Server bytes cannot be recovered.\nConfirm this exact file: ${context.command} ${file.fileId} --yes`};
    }
    const parsed = FileId.safeParse(reference);
    if (!parsed.success) {
        throw new Error('Confirmation requires the full file ID printed in the preview, not a number or name that may have changed.');
    }
    const result = await context.client.deleteFile(context.roomId, context.credential, parsed.data);
    return {result, text: result.removed ? `Deleted ${result.fileId} · freed ${formatFileSize(result.freedBytes)}. The conversation remains.` : `${result.fileId} is already unavailable; no file was removed.`};
}

export type OnlineCleanupOptions = {store: LocalStore; roomId: string; reference: string; confirmed: boolean; command: string; cursor?: string; allowAccountCleanup?: boolean};
export type OnlineCleanupResult = {text: string; files?: StoredFile[]; nextCursor?: string | null; results?: FileCleanupItem[]};

/** Workspace owners can also reclaim archived, hidden and unfinished uploads from the current room. */
export async function onlineRoomCleanup({store, roomId, reference, confirmed, command, cursor, allowAccountCleanup = false}: OnlineCleanupOptions): Promise<OnlineCleanupResult> {
    if (confirmed && !allowAccountCleanup) {
        throw new Error('Workspace-owner cleanup must be confirmed by a person in their own terminal. Agents can use files delete with their own sender/admin authority.');
    }
    const page = await onlineStoredFiles(store, roomId, cursor);
    if (confirmed) {
        const ids = [...new Set(reference.split(',').map((id) => id.trim()).filter(Boolean))];
        if (!ids.length || ids.length > 100 || ids.some((id) => !FileId.safeParse(id).success)) {
            throw new Error('Confirmation needs 1–100 full file IDs from the cleanup list, separated by commas.');
        }
        const result = await cleanupOnlineFiles(store, ids.map((fileId) => ({roomId, fileId})));
        return {results: result.results, text: result.results.map((item) => item.error ? `${item.fileId}: ${item.error}` : item.removed ? `${item.fileId}: removed · ${formatFileSize(item.freedBytes)} freed` : `${item.fileId}: already unavailable in this workspace`).join('\n')};
    }
    const lines = page.files.map((file) => `${file.fileId}  ${file.name} · ${formatFileSize(file.storedBytes)} · ${file.location}`);
    const text = [
        'Stored files in this room, in your signed-in workspace (owner only):',
        ...(lines.length ? lines : ['No stored files.']),
        ...(page.nextCursor ? [`More files: ${command} --after ${page.nextCursor}`] : []),
        `To delete reviewed files: ${command} <file-id>[,<file-id>...] --yes`,
        'This deletes the selected server and archived copies for everyone. Conversations and downloaded copies stay.'
    ].join('\n');
    return {...page, text};
}

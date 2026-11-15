import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test, vi} from 'vitest';
import {LocalStore, PairLobbyClient} from '@pairlobby/client';
import {newId} from '@pairlobby/protocol';
import type {DeleteFileResponse, RoomFile} from '@pairlobby/protocol';
import {deleteRoomFile, onlineRoomCleanup} from '../src/file-cleanup.js';
import type {FileCleanupContext} from '../src/file-cleanup.js';

class RecordingClient extends PairLobbyClient {
    readonly removed: string[] = [];
    constructor() {
        super('https://relay.invalid');
    }
    override async deleteFile(_room: string, _credential: string, fileId: string): Promise<DeleteFileResponse> {
        this.removed.push(fileId);
        return {fileId, removed: true, freedBytes: 7};
    }
}

function attachment(name: string): RoomFile {
    return {fileId: newId('file'), name, size: 7, mediaType: 'text/plain', sha256: '0'.repeat(64), uploaderId: newId('participant'), createdAt: 1, eventId: newId('event')};
}

test('cleanup previews do not delete and confirmation pins the original ID despite list reordering', async () => {
    const client = new RecordingClient();
    const first = attachment('first.txt');
    const other = attachment('other.txt');
    const context: FileCleanupContext = {client, roomId: newId('room'), credential: 'test-only', files: [first, other], command: '/files delete'};
    const preview = await deleteRoomFile('1', false, context);
    expect(preview.preview?.fileId).toBe(first.fileId);
    expect(preview.text).toContain(`/files delete ${first.fileId} --yes`);
    expect(client.removed).toEqual([]);
    context.files.reverse();
    await expect(deleteRoomFile('1', true, context)).rejects.toThrow('full file ID');
    await expect(deleteRoomFile('first.txt', true, context)).rejects.toThrow('full file ID');
    expect(client.removed).toEqual([]);
    await deleteRoomFile(first.fileId, true, context);
    expect(client.removed).toEqual([first.fileId]);
});

test('workspace cleanup defaults to refusing agent confirmation before using account authority', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pairlobby-cleanup-'));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
        const store = new LocalStore(directory);
        await expect(onlineRoomCleanup({store, roomId: newId('room'), reference: newId('file'), confirmed: true, command: 'pairlobby files cleanup'})).rejects.toThrow('confirmed by a person');
        expect(fetcher).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
        rmSync(directory, {recursive: true, force: true});
    }
});

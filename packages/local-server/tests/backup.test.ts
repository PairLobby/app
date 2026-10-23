import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {newCredential} from '@pairlobby/protocol';
import {RoomService} from '@pairlobby/server-core';
import {afterAll, describe, expect, test} from 'vitest';

import {backupName, folderTarget, restoreLatest, startBackups} from '../src/backup.js';
import type {BackupTarget} from '../src/backup.js';
import {SqliteRoomStore} from '../src/sqlite-store.js';

type ClockState = {at: number};

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-backup-'));

afterAll(() => {
    rmSync(directory, {recursive: true, force: true});
});

async function addRoom(store: SqliteRoomStore, name: string): Promise<string> {
    const created = await new RoomService(store).createRoom({name, displayName: 'hugo', kind: 'human', controllerCredential: newCredential('controller'), participantCredential: newCredential('participant')});
    return created.roomId;
}

function mkdirAll(path: string): void {
    rmSync(path, {recursive: true, force: true});
    mkdirSync(path, {recursive: true});
}

function unreachable(): BackupTarget {
    const fail = async () => {
        throw new Error('bucket unreachable');
    };
    return {description: 's3://gone/', put: fail, list: fail, get: fail, remove: fail};
}

describe('backup names', () => {
    test('test_copy_names_sort_by_the_time_they_were_taken', () => {
        expect(backupName(new Date('2026-10-21T18:04:05.123Z'))).toBe('rooms-20261021T180405123Z.sqlite');
        expect([backupName(new Date('2026-10-21T09:00:00Z')), backupName(new Date('2026-10-20T23:00:00Z'))].sort()[0]).toContain('20261020');
    });
});

describe('backup schedule', () => {
    test('test_a_copy_is_taken_only_after_a_change_and_old_copies_are_pruned', async () => {
        mkdirAll(join(directory, 'schedule'));
        const dataFile = join(directory, 'schedule', 'rooms.sqlite');
        const store = new SqliteRoomStore(dataFile);
        const target = folderTarget(join(directory, 'schedule-copies'));
        const clock: ClockState = {at: Date.parse('2026-10-21T10:00:00Z')};
        const schedule = startBackups({source: store, dataFile, target, intervalMs: 3_600_000, keep: 2, now: () => new Date(clock.at)});
        try {
            expect(await schedule.run()).toBeNull();
            for (const name of ['one', 'two', 'three']) {
                await addRoom(store, name);
                clock.at += 60_000;
                expect((await schedule.run())?.name).toBe(backupName(new Date(clock.at)));
            }
            expect(await schedule.run()).toBeNull();
            expect((await target.list()).sort()).toEqual([backupName(new Date(clock.at - 60_000)), backupName(new Date(clock.at))]);
            expect(existsSync(`${dataFile}.backup`)).toBe(false);
        } finally {
            await schedule.stop();
            store.close();
        }
    });

    test('test_a_failed_copy_is_logged_and_tried_again_on_the_next_round', async () => {
        mkdirAll(join(directory, 'failing'));
        const dataFile = join(directory, 'failing', 'rooms.sqlite');
        const store = new SqliteRoomStore(dataFile);
        const lines: string[] = [];
        const working = folderTarget(join(directory, 'failing-copies'));
        let broken = true;
        const flaky: BackupTarget = {...working, put: async (name, file) => (broken ? Promise.reject(new Error('disk full')) : working.put(name, file))};
        const schedule = startBackups({source: store, dataFile, target: flaky, intervalMs: 3_600_000, log: (line) => lines.push(line)});
        try {
            await addRoom(store, 'kept');
            expect(await schedule.run()).toBeNull();
            expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({level: 'error', event: 'backup', error: 'disk full'});
            broken = false;
            expect(await schedule.run()).not.toBeNull();
        } finally {
            await schedule.stop();
            store.close();
        }
    });
});

describe('restore', () => {
    test('test_the_newest_sound_copy_is_restored_and_a_broken_one_is_skipped', async () => {
        mkdirAll(join(directory, 'source'));
        const store = new SqliteRoomStore(join(directory, 'source', 'rooms.sqlite'));
        const target = folderTarget(join(directory, 'restore-copies'));
        const schedule = startBackups({source: store, dataFile: join(directory, 'source', 'rooms.sqlite'), target, intervalMs: 3_600_000, now: () => new Date('2026-10-21T10:00:00Z')});
        const roomId = await addRoom(store, 'restored');
        await schedule.stop();
        store.close();
        writeFileSync(join(directory, 'restore-copies', backupName(new Date('2026-10-21T11:00:00Z'))), 'not a database');

        mkdirAll(join(directory, 'fresh'));
        const dataFile = join(directory, 'fresh', 'rooms.sqlite');
        writeFileSync(`${dataFile}-wal`, 'left over from another database');
        const lines: string[] = [];
        const result = await restoreLatest({target, dataFile, log: (line) => lines.push(line)});
        expect(result).toEqual({outcome: 'restored', backup: {name: 'rooms-20261021T100000000Z.sqlite', takenAt: '2026-10-21T10:00:00.000Z'}});
        expect(lines.map((line) => JSON.parse(line).level)).toEqual(['error', 'info']);
        expect(existsSync(`${dataFile}-wal`)).toBe(false);
        expect(readdirSync(join(directory, 'fresh'))).toEqual(['rooms.sqlite']);
        const restored = new SqliteRoomStore(dataFile);
        try {
            expect((await restored.loadRoom(roomId))?.room.name).toBe('restored');
        } finally {
            restored.close();
        }
        expect(await restoreLatest({target, dataFile})).toEqual({outcome: 'kept-local-data'});
    });

    test('test_no_copies_starts_fresh_but_an_unreachable_target_stops_the_start', async () => {
        expect(await restoreLatest({target: folderTarget(join(directory, 'empty-copies')), dataFile: join(directory, 'none', 'rooms.sqlite')})).toEqual({outcome: 'no-backups'});
        await expect(restoreLatest({target: unreachable(), dataFile: join(directory, 'none', 'rooms.sqlite')})).rejects.toThrow('bucket unreachable');
        mkdirAll(join(directory, 'all-broken'));
        writeFileSync(join(directory, 'all-broken', backupName(new Date())), 'garbage');
        await expect(restoreLatest({target: folderTarget(join(directory, 'all-broken')), dataFile: join(directory, 'none', 'rooms.sqlite')})).rejects.toThrow('none of the 1 copies');
    });
});

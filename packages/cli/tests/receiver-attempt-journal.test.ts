import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {ReceiverAttemptJournal, initializeReceiverDatabase, localDeviceId} from '../src/receiver-attempt-journal.js';

let directory: string;
let database: DatabaseSync;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'pairlobby-attempt-journal-'));
    database = new DatabaseSync(join(directory, 'inbox.sqlite'));
});

afterEach(() => {
    database.close();
    rmSync(directory, {recursive: true, force: true});
});

test('attempt history is immutable events and preserves the first terminal outcome', () => {
    initializeReceiverDatabase(database);
    const journal = new ReceiverAttemptJournal(database);
    const deviceId = localDeviceId(directory);
    expect(localDeviceId(directory)).toBe(deviceId);

    const attemptId = journal.start({
        requestEventId: 'ev_REQUEST000000000000000001',
        ordinal: 2,
        recoversEventId: 'ev_ORIGINAL0000000000000001',
        recoverySourceAttemptId: 'at_PREVIOUS0000000000000001',
        roomId: 'rm_ROOM00000000000000000001',
        participantId: 'pt_AGENT0000000000000000001',
        sessionId: 'se_SESSION00000000000000001',
        ownerDeviceId: deviceId,
        runtime: 'claude',
        model: 'configured-model',
        effort: 'high',
        providerThreadId: 'thread-before',
        workingDirectory: directory,
        receiverProcessId: 123,
        startedAt: 1_000,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 60_000
    });
    journal.activity(attemptId, {startedAt: 1_000, lastActivityAt: 2_000, idleDeadlineAt: 12_000, absoluteDeadlineAt: 61_000});
    journal.runtimeStarted(attemptId, {providerThreadId: 'thread-after', turnId: 'turn-1', processId: 456}, 2_100);
    journal.model(attemptId, 'resolved-model', 2_200);
    journal.usage(attemptId, {inputTokens: 10, outputTokens: 4}, 2_300);
    journal.answerSaved(attemptId, 2_400);
    expect(journal.terminal(attemptId, {kind: 'answered', at: 2_500, responseEventId: 'ev_ANSWER000000000000000001'})).toBe(true);
    expect(journal.terminal(attemptId, {kind: 'adapter_error', at: 2_600, failureReason: 'late overwrite'})).toBe(false);

    expect(journal.list()).toEqual([{
        attemptId,
        schemaVersion: 1,
        requestEventId: 'ev_REQUEST000000000000000001',
        ordinal: 2,
        recoversEventId: 'ev_ORIGINAL0000000000000001',
        recoverySourceAttemptId: 'at_PREVIOUS0000000000000001',
        roomId: 'rm_ROOM00000000000000000001',
        participantId: 'pt_AGENT0000000000000000001',
        sessionId: 'se_SESSION00000000000000001',
        ownerDeviceId: deviceId,
        runtime: 'claude',
        model: 'configured-model',
        effort: 'high',
        providerThreadId: 'thread-before',
        workingDirectory: directory,
        receiverProcessId: 123,
        startedAt: 1_000,
        lastActivityAt: 2_000,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 60_000,
        runtimeStarted: {providerThreadId: 'thread-after', turnId: 'turn-1', processId: 456},
        resolvedModel: 'resolved-model',
        usage: {inputTokens: 10, outputTokens: 4},
        answerSaved: true,
        terminal: {
            kind: 'answered',
            at: 2_500,
            responseEventId: 'ev_ANSWER000000000000000001',
            deadline: {startedAt: 1_000, lastActivityAt: 2_000, idleDeadlineAt: 12_000, absoluteDeadlineAt: 61_000}
        }
    }]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM receiver_attempt_events').get()!['count']).toBe(6);
    expect(() => database.prepare('UPDATE receiver_attempts SET runtime=? WHERE attempt_id=?').run('rewritten', attemptId)).toThrow('append-only');
    expect(() => database.prepare('DELETE FROM receiver_attempt_events WHERE attempt_id=?').run(attemptId)).toThrow('append-only');
});

test('migration adds journal linkage without inventing history for old jobs', () => {
    database.exec("CREATE TABLE jobs(event_id TEXT PRIMARY KEY, phase TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, answer TEXT, failure TEXT, turn_id TEXT); INSERT INTO jobs(event_id, phase) VALUES ('ev_OLD', 'running')");
    initializeReceiverDatabase(database);
    const journal = new ReceiverAttemptJournal(database);
    expect(database.prepare('PRAGMA table_info(jobs)').all().map((row) => row['name'])).toContain('attempt_id');
    expect(journal.crashRunningJobs('restart', 5_000)).toEqual([]);
    expect(journal.list()).toEqual([]);
});

test('restart appends one crash terminal event to a running recorded attempt', () => {
    initializeReceiverDatabase(database);
    const journal = new ReceiverAttemptJournal(database);
    const attemptId = journal.start({
        requestEventId: 'ev_REQUEST',
        ordinal: 1,
        roomId: 'rm_ROOM',
        participantId: 'pt_AGENT',
        sessionId: 'se_SESSION',
        ownerDeviceId: 'device',
        runtime: 'codex',
        workingDirectory: directory,
        receiverProcessId: 123,
        startedAt: 1_000,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 60_000
    });
    database.prepare("INSERT INTO jobs(event_id, phase, attempt_id) VALUES ('ev_REQUEST', 'running', ?)").run(attemptId);
    expect(journal.crashRunningJobs('Receiver restarted', 5_000)).toEqual([attemptId]);
    expect(journal.crashRunningJobs('Receiver restarted again', 6_000)).toEqual([]);
    expect(journal.list('ev_REQUEST')[0]!.terminal).toEqual({kind: 'crash', at: 5_000, failureReason: 'Receiver restarted', cancellationGraceful: null});
});

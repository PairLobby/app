import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {ProviderCooldownStore, detectClaudeUsageLimit, parseResetTime, providerProfileKey, reconcileProviderCooldown} from '../src/provider-limits.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'pairlobby-provider-limit-')); });
afterEach(() => { rmSync(directory, {recursive: true, force: true}); });

test('observed Claude usage exhaustion is typed with an absolute Toronto reset', () => {
    const now = Date.parse('2026-10-11T20:00:00Z');
    const limit = detectClaudeUsageLimit({result: 'Usage limit reached · continuing automatically at 6:20pm · esc to cancel', stderr: "You've hit your session limit · resets 6:20pm (America/Toronto)\nUse your limit reset to reset it now: https://clau.de/reset", now});
    expect(limit).toMatchObject({provider: 'claude', limitKind: 'session', detectedAt: now, retryAt: Date.parse('2026-10-11T22:20:00Z'), resetTimezone: 'America/Toronto', automaticRetry: true, resetActionUrl: 'https://clau.de/reset', source: 'result'});
});

test('reset parsing rolls to the next local day and respects daylight-saving offsets', () => {
    expect(parseResetTime('limit resets 1:30am America/Toronto', Date.parse('2026-03-08T07:00:00Z'))).toEqual({retryAt: Date.parse('2026-03-09T05:30:00Z'), timezone: 'America/Toronto'});
    expect(parseResetTime('limit resets 6:20pm America/Toronto', Date.parse('2026-10-11T23:00:00Z'))).toEqual({retryAt: Date.parse('2026-10-12T22:20:00Z'), timezone: 'America/Toronto'});
});

test('strong limit text without a time waits for manual retry and ordinary failures stay generic', () => {
    expect(detectClaudeUsageLimit({errors: ['Usage limit reached']})).toMatchObject({retryAt: null, automaticRetry: false, source: 'result_errors'});
    expect(detectClaudeUsageLimit({stderr: "You've hit your weekly limit"})).toMatchObject({limitKind: 'weekly', source: 'stderr'});
    expect(detectClaudeUsageLimit({stderr: 'Authentication failed'})).toBeNull();
    expect(detectClaudeUsageLimit({stderr: 'Context window limit reached'})).toBeNull();
    expect(detectClaudeUsageLimit({stderr: 'quota_exceeded: room retained-event quota reached'})).toBeNull();
    expect(detectClaudeUsageLimit({stderr: 'Model claude-missing does not exist or is unavailable'})).toBeNull();
    expect(detectClaudeUsageLimit({stderr: 'Network request timed out'})).toBeNull();
    expect(detectClaudeUsageLimit({stderr: 'Claude produced no runtime activity for 10 minutes'})).toBeNull();
    expect(detectClaudeUsageLimit({stderr: 'Process exited 1'})).toBeNull();
});

test('profile identity resolves the executable from PATH without persisting provider credentials', () => {
    const executable = join(directory, 'claude');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
    const previousPath = process.env['PATH'];
    const previousConfiguration = process.env['CLAUDE_CONFIG_DIR'];
    process.env['PATH'] = `${directory}:${previousPath ?? ''}`;
    try {
        const defaultProfile = providerProfileKey('claude');
        expect(defaultProfile).toBe(providerProfileKey('claude', executable));
        expect(defaultProfile).not.toContain(directory);
        process.env['CLAUDE_CONFIG_DIR'] = join(directory, 'other-profile');
        expect(providerProfileKey('claude')).not.toBe(defaultProfile);
    } finally {
        if (previousPath === undefined) {
            delete process.env['PATH'];
        } else {
            process.env['PATH'] = previousPath;
        }
        if (previousConfiguration === undefined) {
            delete process.env['CLAUDE_CONFIG_DIR'];
        } else {
            process.env['CLAUDE_CONFIG_DIR'] = previousConfiguration;
        }
    }
});

test('cooldown storage survives reopening and clears explicitly', () => {
    const file = join(directory, 'limits.sqlite');
    let store = new ProviderCooldownStore(file);
    const limit = detectClaudeUsageLimit({result: 'session limit reached', now: 1000})!;
    store.set('claude:test', limit);
    const otherReceiver = new ProviderCooldownStore(file);
    expect(otherReceiver.get('claude:test')).toEqual({...limit, repeatedWithoutLaterReset: 0, wakeAt: null});
    otherReceiver.clear('claude:test');
    expect(store.get('claude:test')).toBeNull();
    store.set('claude:test', limit);
    otherReceiver.close();
    store.close();
    store = new ProviderCooldownStore(file);
    expect(store.get('claude:test')).toEqual({...limit, repeatedWithoutLaterReset: 0, wakeAt: null});
    store.clear('claude:test');
    expect(store.get('claude:test')).toBeNull();
    store.close();
});

test('a repeated limit gets one bounded backoff and then requires manual retry', () => {
    const first = reconcileProviderCooldown(null, detectClaudeUsageLimit({result: 'session limit reached; resets 6:20pm America/Toronto', now: Date.parse('2026-10-11T20:00:00Z')})!);
    const second = reconcileProviderCooldown(first, {...first, detectedAt: Date.parse('2026-10-11T22:20:10Z')}, Date.parse('2026-10-11T22:20:10Z'), 10_000);
    expect(second).toMatchObject({automaticRetry: true, retryAt: Date.parse('2026-10-11T22:20:20Z'), repeatedWithoutLaterReset: 1});
    expect(second.displayMessage).toContain('bounded backoff');
    const third = reconcileProviderCooldown(second, {...first, detectedAt: Date.parse('2026-10-11T22:20:30Z')}, Date.parse('2026-10-11T22:20:30Z'), 10_000);
    expect(third).toMatchObject({automaticRetry: false, repeatedWithoutLaterReset: 2});
    expect(third.displayMessage).toContain('automatic retry is off');
    const later = reconcileProviderCooldown(third, {...first, detectedAt: Date.parse('2026-10-11T22:21:00Z'), retryAt: Date.parse('2026-10-12T22:20:00Z')}, Date.parse('2026-10-11T22:21:00Z'));
    expect(later).toMatchObject({automaticRetry: true, retryAt: Date.parse('2026-10-12T22:20:00Z'), repeatedWithoutLaterReset: 0});
});

test('only one live receiver claims a due profile probe and a manual target fences other receivers', () => {
    const file = join(directory, 'claims.sqlite');
    const firstStore = new ProviderCooldownStore(file);
    const secondStore = new ProviderCooldownStore(file);
    const limit = detectClaudeUsageLimit({result: 'session limit reached; resets 6:20pm America/Toronto', now: Date.parse('2026-10-11T20:00:00Z')})!;
    firstStore.set('claude:test', {...limit, retryAt: 1_000});
    expect(firstStore.claimDue({profileKey: 'claude:test', owner: 'receiver-a', pid: process.pid, now: 10_000, leaseMs: 60_000, roomId: 'room-a', participantId: 'agent-a'})).toMatchObject({probeOwner: 'receiver-a'});
    expect(secondStore.claimDue({profileKey: 'claude:test', owner: 'receiver-b', pid: process.pid, now: 10_000, leaseMs: 60_000, roomId: 'room-b', participantId: 'agent-b'})).toBeNull();
    expect(firstStore.releaseProbe('claude:test', 'receiver-a')).toBe(true);
    secondStore.requestRetry('claude:test', {roomId: 'room-a', participantId: 'agent-a', requestId: 'request-a'});
    expect(secondStore.claimDue({profileKey: 'claude:test', owner: 'receiver-b', pid: process.pid, now: 20_000, leaseMs: 60_000, roomId: 'room-b', participantId: 'agent-b'})).toBeNull();
    expect(firstStore.claimDue({profileKey: 'claude:test', owner: 'receiver-a', pid: process.pid, now: 20_000, leaseMs: 60_000, roomId: 'room-a', participantId: 'agent-a'})).toMatchObject({manualTarget: {requestId: 'request-a'}, probeOwner: 'receiver-a'});
    expect(firstStore.clearManualTarget('claude:test', 'receiver-a')).toBe(true);
    const cleared = firstStore.get('claude:test')!;
    expect(cleared.automaticRetry).toBe(true);
    expect(cleared.manualTarget).toBeUndefined();
    expect(cleared.probeOwner).toBeUndefined();
    firstStore.close();
    secondStore.close();
});

test('a dead probe owner cannot strand the shared cooldown', () => {
    const store = new ProviderCooldownStore(join(directory, 'dead-probe.sqlite'));
    const limit = detectClaudeUsageLimit({result: 'session limit reached; resets 6:20pm America/Toronto', now: Date.parse('2026-10-11T20:00:00Z')})!;
    store.set('claude:test', {...limit, retryAt: 1_000, repeatedWithoutLaterReset: 0, wakeAt: 1_000, probeOwner: 'dead', probePid: 2_000_000_000, probeExpiresAt: 100_000});
    expect(store.claimDue({profileKey: 'claude:test', owner: 'replacement', pid: process.pid, now: 10_000, leaseMs: 60_000, roomId: 'room', participantId: 'agent'})).toMatchObject({probeOwner: 'replacement', probePid: process.pid});
    store.close();
});

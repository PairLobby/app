import {expect, test} from 'vitest';
import type {AccountUsage} from '@pairlobby/protocol';
import {usageReport} from '../src/usage.js';

test('usage separates persistent storage, period allowances and external AI credits', () => {
    const usage: AccountUsage = {
        workspaceId: 'test', plan: 'free', active: true, periodStart: 1, periodEnd: Date.UTC(2026, 11, 1),
        messages: {used: 1250, limit: 5000}, requests: {used: 60000, limit: 50000},
        storage: {used: 23 * 1024 * 1024, limit: 50 * 1024 * 1024}, files: {used: 20, limit: 50}, filesShareStorage: true,
        rooms: {used: 1, limit: 2}, agents: {used: 2, limit: 3}, archivedBytes: 1024
    };
    const report = usageReport(usage);
    expect(report).toContain('23 MB / 50 MB (46%) · 27 MB remaining');
    expect(report).toMatch(/Work events:.*25%/);
    expect(report).toMatch(/API requests:.*0 remaining/);
    expect(report).toContain('reset');
    expect(report).toContain('Storage does not reset');
    expect(report).toContain('AI-provider tokens and credits are separate');
    expect(report).not.toContain('File storage:');
    expect(usageReport({...usage, filesShareStorage: false})).toContain('File storage:');
});

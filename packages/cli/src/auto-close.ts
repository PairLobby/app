//! Auto-close as people type and read it: `off`, `idle:2h`, `age:24h` or
//! `agents-and-guests-left`, shared by the shell, both settings menus and the transcript.

import {ProtocolError} from '@pairlobby/protocol';
import type {AutoClosePolicy, CloseReason} from '@pairlobby/protocol';
import {PairLobbyClient} from '@pairlobby/client';
import type {LocalStore} from '@pairlobby/client';

import {UsageError} from './context.js';
import type {PanelChoice} from './room-panel.js';
import {WhenError, formatDuration, parseDuration} from './when.js';

export const AUTO_CLOSE_USAGE = 'off, idle:<duration>, age:<duration> or agents-and-guests-left (for example idle:2h)';

function duration(text: string): number {
    try {
        const ms = parseDuration(text.trim());
        if (ms < 60_000) {
            throw new UsageError('auto-close durations start at one minute');
        }
        return ms;
    } catch (error) {
        if (error instanceof UsageError) {
            throw error;
        }
        throw new UsageError(error instanceof WhenError ? error.message : String(error));
    }
}

export function parseAutoClose(spec: string): AutoClosePolicy {
    const value = spec.trim().toLowerCase();
    if (['off', 'never', 'none', 'no'].includes(value)) {
        return {mode: 'off'};
    }
    if (['agents-and-guests-left', 'agents_and_guests_left', 'agents-left', 'departure'].includes(value)) {
        return {mode: 'agents_and_guests_left'};
    }
    const match = /^(idle|inactivity|age):(.+)$/.exec(value);
    if (!match) {
        throw new UsageError(`auto-close takes ${AUTO_CLOSE_USAGE}, not "${spec}"`);
    }
    return {mode: match[1] === 'age' ? 'age' : 'inactivity', afterMs: duration(match[2]!)};
}

/** The largest whole unit, as typed: 2h, 90m, 7d. */
function compactDuration(ms: number): string {
    for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000]] as const) {
        if (ms % size === 0) {
            return `${ms / size}${unit}`;
        }
    }
    return `${Math.round(ms / 1000)}s`;
}

export function formatAutoClose(policy: AutoClosePolicy): string {
    switch (policy.mode) {
        case 'off':                    return 'off';
        case 'inactivity':             return `idle:${compactDuration(policy.afterMs)}`;
        case 'age':                    return `age:${compactDuration(policy.afterMs)}`;
        case 'agents_and_guests_left': return 'agents-and-guests-left';
    }
}

export function describeAutoClose(policy: AutoClosePolicy | undefined): string {
    switch (policy?.mode ?? 'off') {
        case 'inactivity':             return `After ${formatDuration((policy as {afterMs: number}).afterMs)} without messages`;
        case 'age':                    return `${formatDuration((policy as {afterMs: number}).afterMs)} after creation`;
        case 'agents_and_guests_left': return 'When all agents and guests have left';
        default:                       return 'Off';
    }
}

export function describeCloseReason(reason: CloseReason | undefined): string {
    switch (reason) {
        case 'inactivity':             return 'closed automatically after inactivity';
        case 'age':                    return 'closed automatically at its age limit';
        case 'agents_and_guests_left': return 'closed automatically after all agents and guests left';
        default:                       return 'closed';
    }
}

export const AUTO_CLOSE_CHOICES: PanelChoice[] = [
    {label: 'Off — never close automatically', value: 'off'},
    {label: 'After 1 hour without messages', value: 'idle:1h'},
    {label: 'After 24 hours without messages', value: 'idle:24h'},
    {label: 'After 7 days without messages', value: 'idle:7d'},
    {label: '24 hours after creation', value: 'age:24h'},
    {label: '7 days after creation', value: 'age:7d'},
    {label: 'When all agents and guests have left', value: 'agents-and-guests-left'},
    {label: 'Custom — type idle:<duration> or age:<duration>', value: 'custom', custom: true},
];

export type BulkOutcome = {roomId: string; name: string; result: 'updated' | 'unchanged' | 'skipped' | 'unreachable' | 'rejected'; detail: string};

/**
 * Applies one policy to the rooms this device knows and administers. Each room is
 * reported on its own: a room this device cannot change, cannot reach, or whose
 * relay refuses is listed with the reason rather than hidden behind a total.
 */
export async function applyAutoCloseToRooms(store: LocalStore, policy: AutoClosePolicy): Promise<BulkOutcome[]> {
    const outcomes: BulkOutcome[] = [];
    for (const room of store.rooms()) {
        const owner = store.credential(room.roomId, 'controller') ?? room.sessions.filter((session) => session.role === 'controller').map((session) => store.credential(room.roomId, session.sessionId)).find(Boolean);
        const report = (result: BulkOutcome['result'], detail: string) => outcomes.push({roomId: room.roomId, name: room.name, result, detail});
        if (!owner) {
            report('skipped', 'this device has no owner or admin access');
            continue;
        }
        const client = new PairLobbyClient(room.serverUrl);
        try {
            const snapshot = await client.snapshot(room.roomId, owner);
            if (snapshot.lifecycle !== 'open') {
                report('skipped', `room is ${snapshot.lifecycle}`);
                continue;
            }
            if (!snapshot.autoCloseSupported) {
                report('skipped', 'this relay does not support auto-close yet');
                continue;
            }
            await client.setAutoClose(room.roomId, owner, policy);
            report('updated', describeAutoClose(policy));
        } catch (error) {
            if (error instanceof ProtocolError && error.code === 'server_unavailable') {
                report('unreachable', error.message);
            } else if (error instanceof ProtocolError && error.code === 'invalid_request' && error.message.includes('already')) {
                report('unchanged', 'already set');
            } else {
                report('rejected', error instanceof Error ? error.message : String(error));
            }
        }
    }
    return outcomes;
}

export function summarizeBulk(outcomes: BulkOutcome[]): string {
    if (!outcomes.length) {
        return 'No rooms are saved on this device.';
    }
    const counts = outcomes.reduce<Record<string, number>>((total, outcome) => ({...total, [outcome.result]: (total[outcome.result] ?? 0) + 1}), {});
    return Object.entries(counts).map(([result, count]) => `${count} ${result}`).join(', ');
}

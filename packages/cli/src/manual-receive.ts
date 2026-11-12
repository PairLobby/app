import type {LocalStore, Settings} from '@pairlobby/client';
import {UsageError} from './context.js';
import {detectRuntime} from './runtime-detect.js';

export type ManualReceiveCallerHints = {agent?: boolean; runtime?: string | undefined; sessionId?: string | undefined};
export type ManualReceiveCaller = {agent: boolean; interactive: boolean};

export const MANUAL_RECEIVE_DISABLED = '--manual-receive is disabled on this device. The user must first enable "Allow manual receiving" in pairlobby settings, or run "pairlobby settings allow-manual-receive on" in their own terminal. Automatic receiving remains the default.';
export const MANUAL_RECEIVE_USER_ONLY = 'Only a person at an interactive terminal may change allow-manual-receive. Agent sessions cannot enable this permission; --human does not override that restriction.';

/** Permission to opt out is distinct from selecting manual mode for a particular create/join command. */
export function assertManualReceiveAllowed(settings: Pick<Settings, 'allowManualReceive'>): void {
    if (settings.allowManualReceive !== true) {
        throw new UsageError(MANUAL_RECEIVE_DISABLED);
    }
}

/** Use all available caller evidence. A profile name or --human cannot erase an agent runtime/session. */
export function manualReceiveCaller(store: LocalStore, hints: ManualReceiveCallerHints = {}): ManualReceiveCaller {
    let agent = Boolean(hints.agent || hints.runtime || detectRuntime().runtime);
    const scopes = [hints.sessionId, process.env['PAIRLOBBY_SESSION']].filter((value): value is string => Boolean(value));
    if (scopes.length) {
        const sessions = store.rooms().flatMap((room) => room.sessions);
        agent ||= scopes.some((scope) => {
            const matches = sessions.filter((session) => session.sessionId === scope || session.participantId === scope);
            return matches.length === 0 || matches.some((session) => session.kind !== 'human');
        });
    }
    return {agent, interactive: process.stdin.isTTY === true && process.stdout.isTTY === true};
}

export function assertManualReceiveSettingChange(caller: ManualReceiveCaller): void {
    if (caller.agent || !caller.interactive) {
        throw new UsageError(MANUAL_RECEIVE_USER_ONLY);
    }
}

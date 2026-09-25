import type {LocalStore, RoomEntry, SessionEntry} from '@pairlobby/client';
import {select, UsageError} from './context.js';
import type {Selection} from './context.js';
import {chooseFromMenu} from './picker.js';

type ChooseHuman = (sessions: SessionEntry[]) => Promise<string | undefined>;

/** Select a saved identity by ID. A shared name never confers membership. */
export async function selectHumanSession(store: LocalStore, room: RoomEntry, choose?: ChooseHuman): Promise<Selection> {
    const humans = room.sessions.filter((session) => session.kind === 'human');
    let sessionId = room.preferredHumanSessionId;
    if (sessionId && !humans.some((session) => session.sessionId === sessionId)) {
        throw new UsageError('The saved human session is missing. Choose a human membership explicitly with --session.');
    }
    if (!sessionId) {
        if (humans.length === 0) {
            throw new UsageError('No saved human membership in this room. Join with an invite using --human first.');
        }
        if (humans.length === 1) {
            sessionId = humans[0]!.sessionId;
        } else {
            if (!choose) {
                throw new UsageError(`Several human sessions exist; pass --session: ${humans.map((session) => `${session.displayName} (${session.sessionId})`).join(', ')}`);
            }
            sessionId = await choose(humans);
            if (!sessionId) {
                throw new UsageError('Session selection cancelled.');
            }
            if (!humans.some((session) => session.sessionId === sessionId)) {
                throw new UsageError('Choose one of the saved human sessions.');
            }
        }
    }
    return select(store, room.roomId, sessionId);
}

export function chooseHumanSession(sessions: SessionEntry[]): Promise<string | undefined> {
    return chooseFromMenu('Choose your human membership (remembered for this room)', sessions.map((session) => ({label: session.displayName, hint: session.sessionId, value: session.sessionId})));
}

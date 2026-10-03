//! Maps an invite code to its room when each room lives in its own Durable Object.
//! One directory object per code digest: claiming a code is atomic within that
//! object, so two rooms can never hold the same code, and no global coordinator
//! serializes unrelated invitations.

import {DurableObject} from 'cloudflare:workers';

type Entry = {roomId: string; expiresAt: number | null};

export class PairLobbyInviteDirectory extends DurableObject {
    /** Claims this code for `roomId`. False when another room already holds it. */
    async reserve(roomId: string, expiresAt: number | null): Promise<boolean> {
        const existing = await this.ctx.storage.get<Entry>('entry');
        if (existing && existing.roomId !== roomId) {
            return false;
        }
        await this.ctx.storage.put('entry', {roomId, expiresAt});
        return true;
    }

    /**
     * The room holding this code. The entry outlives expiry as a tombstone so a
     * code is never handed to a second room; the room itself decides validity.
     */
    async lookup(): Promise<string | null> {
        return (await this.ctx.storage.get<Entry>('entry'))?.roomId ?? null;
    }
}

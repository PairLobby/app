import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {PairLobbyClient, unreceipted} from '@pairlobby/client';
import {ProtocolError} from '@pairlobby/protocol';

type ReceiptMonitorOptions = {serverUrl: string; roomId: string; participantId: string; credential: string; cursorPath: string; onError: (message: string) => void};
export type ReceiptMonitor = {stop: () => Promise<void>};

/** Transport receipts never schedule model work, claim a turn, or create a reply. */
export function startReceiptMonitor(options: ReceiptMonitorOptions): ReceiptMonitor {
    // Separate socket/cursor from the request dispatcher: receiving continues
    // while a model is busy, waiting for its turn, paused, or muted.
    const client = new PairLobbyClient(options.serverUrl);
    const abort = new AbortController();
    let cursor = 0;
    let stopped = false;
    let lastError = '';
    const report = (message: string) => {
        if (lastError !== message) {
            lastError = message;
            options.onError(message);
        }
    };
    if (existsSync(options.cursorPath)) {
        try {
            const saved = JSON.parse(readFileSync(options.cursorPath, 'utf8')) as {cursor?: unknown};
            if (typeof saved.cursor === 'number' && Number.isSafeInteger(saved.cursor) && saved.cursor >= 0) {
                cursor = saved.cursor;
            }
        } catch {
            // Re-reading is safe: the relay deduplicates per message/reader.
        }
    }

    async function run(): Promise<void> {
        let failures = 0;
        while (!stopped) {
            try {
                const snapshot = await client.snapshot(options.roomId, options.credential);
                const member = snapshot.participants.find((person) => person.participantId === options.participantId);
                if (!member || member.left || member.revoked || member.role === 'guest' || snapshot.lifecycle !== 'open') {
                    return;
                }
                const after = Math.max(cursor, snapshot.earliestSeq - 1, 0);
                const page = await client.readEvents(options.roomId, options.credential, after, 200);
                for (const event of unreceipted(page.events, options.participantId, snapshot.messageReceiptScope === 'members')) {
                    if (stopped) {
                        return;
                    }
                    await client.acknowledgeMessage(options.roomId, options.credential, event.eventId);
                }
                if (stopped) {
                    return;
                }
                const next = page.events.at(-1)?.seq ?? after;
                if (next !== cursor) {
                    // Commit only after every receipt succeeded. On retry, the
                    // server preserves the original acknowledgement timestamp.
                    const temporary = `${options.cursorPath}.${process.pid}.tmp`;
                    writeFileSync(temporary, JSON.stringify({cursor: next}) + '\n', {mode: 0o600});
                    renameSync(temporary, options.cursorPath);
                    cursor = next;
                }
                failures = 0;
                report('');
                if (!page.hasMore) {
                    await client.waitForChange(options.roomId, options.credential, cursor, 300_000, 1000);
                }
            } catch (error) {
                if (stopped) {
                    return;
                }
                report(error instanceof Error ? error.message : 'Message receipts are unavailable');
                if (error instanceof ProtocolError && ['room_expired', 'room_closed', 'room_not_found', 'participant_revoked', 'unauthorized'].includes(error.code)) {
                    return;
                }
                client.closeLive();
                await sleep(Math.min(5000, 250 * 2 ** Math.min(failures++, 5)), undefined, {signal: abort.signal}).catch(() => {});
            }
        }
    }

    const done = run().finally(() => client.closeLive());
    let stopping: Promise<void> | undefined;
    return {
        stop: () => {
            if (stopping) {
                return stopping;
            }
            stopped = true;
            abort.abort();
            client.closeLive();
            // A connect-ticket request may still be in flight. Close a socket
            // created after stop too, rather than waiting out its idle timeout.
            const closing = setInterval(() => client.closeLive(), 100);
            closing.unref();
            stopping = done.finally(() => clearInterval(closing));
            return stopping;
        }
    };
}

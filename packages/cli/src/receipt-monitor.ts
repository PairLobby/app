import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {PairLobbyClient, ReceiptCoalescer, RoomSubscription, unreceipted} from '@pairlobby/client';
import {ProtocolError} from '@pairlobby/protocol';

type ReceiptMonitorOptions = {serverUrl: string; roomId: string; participantId: string; credential: string; cursorPath: string; onError: (message: string) => void; subscription?: RoomSubscription};
export type ReceiptMonitor = {stop: () => Promise<void>};

/** Transport receipts never schedule model work, claim a turn, or create a reply. */
export function startReceiptMonitor(options: ReceiptMonitorOptions): ReceiptMonitor {
    // Consumption remains independent while the transport is shared with dispatch.
    const client = options.subscription?.client ?? new PairLobbyClient(options.serverUrl);
    const live = options.subscription ?? new RoomSubscription(client, options.roomId, options.credential);
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
    // On a relay that keeps plain receipts only as watermarks: one post every few seconds instead of one per message.
    const watermark = new ReceiptCoalescer((throughSeq) => client.postReceipt(options.roomId, options.credential, throughSeq), {onError: (error) => report(error instanceof Error ? error.message : 'Message receipts are unavailable')});
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
                const version = live.version;
                const snapshot = await live.snapshot();
                const member = snapshot.participants.find((person) => person.participantId === options.participantId);
                if (!member || member.left || member.revoked || member.role === 'guest' || snapshot.lifecycle !== 'open') {
                    return;
                }
                const after = Math.max(cursor, snapshot.earliestSeq - 1, 0);
                const page = await live.read(after, 200);
                if (snapshot.receiptMode === 'watermark') {
                    // A saved cursor proves delivery even if the process stopped before its coalesced post succeeded.
                    watermark.advance(cursor);
                    watermark.advance(page.events.at(-1)?.seq ?? 0);
                } else {
                    for (const event of unreceipted(page.events, options.participantId, snapshot.messageReceiptScope === 'members')) {
                        if (stopped) {
                            return;
                        }
                        await client.acknowledgeMessage(options.roomId, options.credential, event.eventId);
                    }
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
                    await live.wait(version, 300_000, abort.signal);
                }
            } catch (error) {
                if (stopped) {
                    return;
                }
                report(error instanceof Error ? error.message : 'Message receipts are unavailable');
                if (error instanceof ProtocolError && ['room_expired', 'room_closed', 'room_not_found', 'participant_revoked', 'unauthorized'].includes(error.code)) {
                    return;
                }
                if (!options.subscription) {
                    client.closeLive();
                }
                await sleep(Math.min(5000, 250 * 2 ** Math.min(failures++, 5)), undefined, {signal: abort.signal}).catch(() => {});
            }
        }
    }

    // What was received before stopping is still reported, then nothing more.
    const done = run().finally(async () => {
        await watermark.flush().catch(() => {});
        watermark.stop();
        if (!options.subscription) {
            await live.stop();
        }
    });
    let stopping: Promise<void> | undefined;
    return {
        stop: () => {
            if (stopping) {
                return stopping;
            }
            stopped = true;
            abort.abort();
            if (!options.subscription) {
                void live.stop();
            }
            stopping = done;
            return stopping;
        }
    };
}

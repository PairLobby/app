import {PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, ProtocolError} from '@pairlobby/protocol';
import type {ExportMetadata, RoomEvent} from '@pairlobby/protocol';

import type {RoomStore} from './store.js';

export type ExportFormat = 'json' | 'ndjson';
export type ExportSource = {metadata: ExportMetadata; events: AsyncIterable<RoomEvent>};

/** Bind replay to the captured head. A concurrent retention gap fails the stream instead of claiming a complete export. */
export async function* retainedEvents(store: RoomStore, roomId: string, earliest: number, latest: number): AsyncGenerator<RoomEvent> {
    let after = earliest - 1;
    while (after < latest) {
        const page = await store.readEvents(roomId, after, 100, latest);
        if (page.events.length === 0) {
            throw new ProtocolError('cursor_gap', 'history changed during export; retry');
        }
        for (const event of page.events) {
            if (event.seq !== after + 1) {
                throw new ProtocolError('cursor_gap', 'history changed during export; retry');
            }
            after = event.seq;
            yield event;
        }
    }
}

/** One event per pull; backpressure and cancellation propagate to archived and live event sources alike. */
export function exportResponse(source: ExportSource, format: ExportFormat = 'json'): Response {
    const encoder = new TextEncoder();
    const events = source.events[Symbol.asyncIterator]();
    let started = false;
    let count = 0;
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            timer = setTimeout(() => {
                finished = true;
                controller.error(new Error('Export timed out; retry with a faster connection'));
                void events.return?.().catch(() => {});
            }, 120_000);
        },
        async cancel() {
            finished = true;
            clearTimeout(timer);
            await events.return?.();
        },
        async pull(controller) {
            try {
                if (!started) {
                    started = true;
                    const header = format === 'ndjson' ? JSON.stringify({kind: 'metadata', metadata: source.metadata}) + '\n' : JSON.stringify(source.metadata).slice(0, -1) + ',"events":[';
                    controller.enqueue(encoder.encode(header));
                    return;
                }
                const next = await events.next();
                if (finished) {
                    return;
                }
                if (next.done) {
                    finished = true;
                    clearTimeout(timer);
                    controller.enqueue(encoder.encode(format === 'ndjson' ? JSON.stringify({kind: 'complete', events: count}) + '\n' : ']}\n'));
                    controller.close();
                    return;
                }
                controller.enqueue(encoder.encode(format === 'ndjson' ? JSON.stringify({kind: 'event', event: next.value}) + '\n' : (count ? ',' : '') + JSON.stringify(next.value)));
                count++;
            } catch (error) {
                finished = true;
                clearTimeout(timer);
                controller.error(error);
                await events.return?.();
            }
        }
    }, {highWaterMark: 0});
    return new Response(stream, {headers: {'content-type': format === 'ndjson' ? 'application/x-ndjson' : 'application/json', 'cache-control': 'private, no-store', [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION)}});
}

import type {MessageRequest, RequestPage, RoomEvent} from '@pairlobby/protocol';
import type {EventPage} from './store.js';

export const MAX_PAGE_BYTES = 256 * 1024;
export const MAX_PAGE_RECORDS = 500;
export type JsonRow = {body: string; receivedAt?: number | null};
type JsonPage<T> = {records: T[]; hasMore: boolean};
type JsonDecoder<T> = (row: JsonRow) => T;

/** Consume a cursor only through the first record that would exceed the page, including a single large legacy record. */
function jsonPage<T>(rows: Iterable<JsonRow>, limit: number, decode: JsonDecoder<T>): JsonPage<T> {
    const records: T[] = [];
    let bytes = 0;
    const count = Math.max(1, Math.min(limit, MAX_PAGE_RECORDS));
    const encoder = new TextEncoder();
    for (const row of rows) {
        const record = decode(row);
        const size = encoder.encode(JSON.stringify(record)).byteLength;
        if (records.length >= count || (records.length > 0 && bytes + size > MAX_PAGE_BYTES)) {
            return {records, hasMore: true};
        }
        records.push(record);
        bytes += size;
    }
    return {records, hasMore: false};
}

export function eventPage(rows: Iterable<JsonRow>, limit: number): EventPage {
    const {records, hasMore} = jsonPage<RoomEvent>(rows, limit, (row) => JSON.parse(row.body) as RoomEvent);
    return {events: records, hasMore};
}

export function requestPage(rows: Iterable<JsonRow>, limit: number): RequestPage {
    const {records, hasMore} = jsonPage<MessageRequest>(rows, limit, receivedRequest);
    return {requests: records, hasMore};
}

export function receivedRequest(row: JsonRow): MessageRequest {
    const request = JSON.parse(row.body) as MessageRequest;
    return {...request, receivedAt: request.receivedAt ?? row.receivedAt ?? null};
}

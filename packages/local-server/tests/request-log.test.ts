import {describe, expect, test} from 'vitest';

import {requestIdFor, requestLogLine, roomHashOf, routePattern, shouldLog} from '../src/request-log.js';

describe('request log', () => {
    test('test_routes_group_by_shape_and_carry_no_identifiers', () => {
        expect(routePattern('/v1/rooms/rm_YC58EFXGPCPF00F8PKHBMRA5X4/events')).toBe('/v1/rooms/:room/events');
        expect(routePattern('/v1/rooms/rm_YC58EFXGPCPF00F8PKHBMRA5X4/files/fl_YC58EFXGPCPF00F8PKHBMRA5X4')).toBe('/v1/rooms/:room/files/:id');
        expect(routePattern('/v1/rooms/anything-a-caller-typed/requests/ev_PM87QBVZPZH9GCNPGNVPXSS5S7/ack')).toBe('/v1/rooms/:room/requests/:id/ack');
        expect(routePattern('/v1/rooms/local')).toBe('/v1/rooms/local');
        expect(routePattern('/v1/invites/redeem')).toBe('/v1/invites/redeem');
    });

    test('test_a_room_is_followed_by_a_short_hash_never_its_id', () => {
        const hash = roomHashOf('/v1/rooms/rm_YC58EFXGPCPF00F8PKHBMRA5X4/events');
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
        expect(roomHashOf('/v1/rooms/rm_YC58EFXGPCPF00F8PKHBMRA5X4')).toBe(hash);
        expect(roomHashOf('/v1/rooms')).toBeUndefined();
        expect(roomHashOf('/v1/rooms/local')).toBeUndefined();
    });

    test('test_a_caller_cannot_put_text_in_the_log_through_the_request_id', () => {
        expect(requestIdFor('abc-123_X.y')).toBe('abc-123_X.y');
        expect(requestIdFor('line\nbreak')).toMatch(/^[0-9a-f-]{36}$/);
        expect(requestIdFor('x'.repeat(65))).toMatch(/^[0-9a-f-]{36}$/);
        expect(requestIdFor(null)).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('test_writes_mode_skips_successful_reads_only', () => {
        expect(shouldLog('writes', 'GET', 200)).toBe(false);
        expect(shouldLog('writes', 'GET', 401)).toBe(true);
        expect(shouldLog('writes', 'POST', 201)).toBe(true);
        expect(shouldLog('all', 'GET', 200)).toBe(true);
    });

    test('test_a_line_is_one_json_object_with_the_documented_fields', () => {
        const line = JSON.parse(requestLogLine({requestId: 'r1', method: 'POST', path: '/v1/rooms/rm_YC58EFXGPCPF00F8PKHBMRA5X4/events', status: 503, ms: 12, at: new Date(0)}));
        expect(line).toEqual({ts: '1970-01-01T00:00:00.000Z', level: 'warn', event: 'request', requestId: 'r1', method: 'POST', route: '/v1/rooms/:room/events', status: 503, ms: 12, roomHash: roomHashOf('/v1/rooms/rm_YC58EFXGPCPF00F8PKHBMRA5X4')});
    });
});

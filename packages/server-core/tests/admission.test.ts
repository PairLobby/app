import {ProtocolError} from '@pairlobby/protocol';
import {describe, expect, test} from 'vitest';

import {CREATE_TOKEN_HEADER, CREATE_TOKEN_REQUIRED, TEAM_TOKEN_REFUSED, createAdmission, memoryRateLimiter, proxiedAddress} from '../src/admission.js';

type ClockState = {at: number};

function post(headers: Record<string, string> = {}): Request {
    return new Request('http://relay/v1/rooms', {method: 'POST', headers});
}

async function refusal(work: Promise<void>): Promise<ProtocolError> {
    const error = await work.then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProtocolError);
    return error as ProtocolError;
}

describe('rate limiter in memory', () => {
    test('test_a_key_gets_its_minute_of_attempts_then_waits_for_the_next_one', async () => {
        const clock: ClockState = {at: 0};
        const limiter = memoryRateLimiter({now: () => clock.at});
        for (let attempt = 0; attempt < 3; attempt++) {
            expect(await limiter.take('a', 1, {perMinute: 3})).toEqual({ok: true});
        }
        expect(await limiter.take('a', 1, {perMinute: 3})).toEqual({ok: false, retryAfterMs: 20_000});
        expect(await limiter.take('b', 1, {perMinute: 3})).toEqual({ok: true});
        clock.at = 20_000;
        expect(await limiter.take('a', 1, {perMinute: 3})).toEqual({ok: true});
        expect((await limiter.take('a', 1, {perMinute: 3})).ok).toBe(false);
    });

    test('test_forgetting_idle_keys_keeps_memory_bounded_without_resetting_busy_ones', async () => {
        const clock: ClockState = {at: 0};
        const limiter = memoryRateLimiter({now: () => clock.at, maxKeys: 2});
        await limiter.take('busy', 2, {perMinute: 2});
        clock.at = 60_000;
        await limiter.take('idle-1', 0, {perMinute: 2});
        await limiter.take('busy', 2, {perMinute: 2});
        await limiter.take('idle-2', 0, {perMinute: 2});
        expect((await limiter.take('busy', 1, {perMinute: 2})).ok).toBe(false);
    });
});

describe('admission', () => {
    test('test_a_relay_with_a_create_token_refuses_rooms_without_it', async () => {
        const admission = createAdmission({createToken: 'team-secret'});
        const missing = await refusal(admission.beforeCreate(post()));
        expect(missing.code).toBe('unauthorized');
        expect(missing.message).toBe(CREATE_TOKEN_REQUIRED);
        expect((await refusal(admission.beforeCreate(post({[CREATE_TOKEN_HEADER]: 'team-secreT'})))).code).toBe('unauthorized');
        await admission.beforeCreate(post({[CREATE_TOKEN_HEADER]: 'team-secret'}));
        await createAdmission({}).beforeCreate(post());
    });

    test('test_room_creation_is_limited_per_address_and_exempt_callers_are_not_counted', async () => {
        const admission = createAdmission({limiter: memoryRateLimiter(), limits: {createPerMinutePerAddress: 2}, clientAddress: (request) => request.headers.get('x-test-address') ?? undefined, exempt: (request) => request.headers.has('x-test-exempt')});
        const from = (address: string) => post({'x-test-address': address});
        await admission.beforeCreate(from('10.0.0.1'));
        await admission.beforeCreate(from('10.0.0.1'));
        const limited = await refusal(admission.beforeCreate(from('10.0.0.1')));
        expect(limited.code).toBe('rate_limited');
        expect(limited.details.retryAfterMs).toBeGreaterThan(0);
        expect(limited.httpStatus).toBe(429);
        await admission.beforeCreate(from('10.0.0.2'));
        for (let attempt = 0; attempt < 5; attempt++) {
            await admission.beforeCreate(post({'x-test-address': '10.0.0.1', 'x-test-exempt': '1'}));
        }
    });

    test('test_unknown_invite_codes_cost_twice_and_the_whole_relay_has_a_ceiling', async () => {
        const admission = createAdmission({limiter: memoryRateLimiter(), limits: {redeemPerMinutePerAddress: 4, redeemPerMinuteGlobal: 5}, clientAddress: (request) => request.headers.get('x-test-address') ?? undefined});
        const from = (address: string) => new Request('http://relay/v1/invites/redeem', {method: 'POST', headers: {'x-test-address': address}});
        await admission.beforeRedeem(from('a'));
        await admission.afterUnknownInvite(from('a'));
        await admission.beforeRedeem(from('a'));
        await admission.afterUnknownInvite(from('a'));
        expect((await refusal(admission.beforeRedeem(from('a')))).code).toBe('rate_limited');
        await admission.beforeRedeem(from('b'));
        await admission.beforeRedeem(from('c'));
        await admission.beforeRedeem(from('d'));
        expect((await refusal(admission.beforeRedeem(from('e')))).code).toBe('rate_limited');
    });
});

describe('team token check', () => {
    const check = (headers: Record<string, string> = {}) => new Request('http://relay/api/online/account', {headers});

    test('test_a_missing_and_a_wrong_team_token_are_refused_alike', async () => {
        const admission = createAdmission({createToken: 'team-secret'});
        const missing = await refusal(admission.beforeAccountCheck(check()));
        const wrong = await refusal(admission.beforeAccountCheck(check({[CREATE_TOKEN_HEADER]: 'team-secreT'})));
        expect([missing.code, missing.message, missing.httpStatus]).toEqual(['unauthorized', TEAM_TOKEN_REFUSED, 401]);
        expect([wrong.code, wrong.message, wrong.httpStatus]).toEqual(['unauthorized', TEAM_TOKEN_REFUSED, 401]);
        await admission.beforeAccountCheck(check({[CREATE_TOKEN_HEADER]: 'team-secret'}));
        expect(await admission.tokenMatches(check({[CREATE_TOKEN_HEADER]: 'team-secret'}))).toBe(true);
        expect(await createAdmission({}).tokenMatches(check({[CREATE_TOKEN_HEADER]: 'anything'}))).toBe(false);
    });

    test('test_token_checks_have_their_own_bucket_apart_from_room_creation', async () => {
        const admission = createAdmission({createToken: 'team-secret', limiter: memoryRateLimiter(), limits: {accountCheckPerMinutePerAddress: 2, createPerMinutePerAddress: 2}, clientAddress: () => '10.0.0.9'});
        await refusal(admission.beforeAccountCheck(check({[CREATE_TOKEN_HEADER]: 'guess-1'})));
        await refusal(admission.beforeAccountCheck(check({[CREATE_TOKEN_HEADER]: 'guess-2'})));
        const limited = await refusal(admission.beforeAccountCheck(check({[CREATE_TOKEN_HEADER]: 'team-secret'})));
        expect([limited.code, limited.httpStatus]).toEqual(['rate_limited', 429]);
        expect(limited.details.retryAfterMs).toBeGreaterThan(0);
        await admission.beforeCreate(post({[CREATE_TOKEN_HEADER]: 'team-secret'}));
        await admission.beforeCreate(post({[CREATE_TOKEN_HEADER]: 'team-secret'}));
        expect((await refusal(admission.beforeCreate(post({[CREATE_TOKEN_HEADER]: 'team-secret'})))).code).toBe('rate_limited');
    });
});

describe('proxied address', () => {
    test('test_the_address_the_proxy_added_wins_over_what_the_caller_wrote', () => {
        const request = new Request('http://relay/', {headers: {'x-forwarded-for': '203.0.113.9, 10.1.2.3'}});
        expect(proxiedAddress(request, 'x-forwarded-for')).toBe('10.1.2.3');
        expect(proxiedAddress(new Request('http://relay/'), 'x-forwarded-for')).toBeUndefined();
        expect(proxiedAddress(new Request('http://relay/', {headers: {'x-forwarded-for': ' , '}}), 'x-forwarded-for')).toBeUndefined();
    });
});

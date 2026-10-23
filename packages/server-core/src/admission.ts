//! Who may start rooms and how fast anyone may try invite codes: the checks a relay
//! reachable from a network needs before a request reaches a room. Shared by every
//! relay so the rules and their wording are the same on each.

import {ProtocolError, digestsEqual, hashCredential} from '@pairlobby/protocol';

/** The header that carries a relay's create token, the same one a hosted account token travels in. */
export const CREATE_TOKEN_HEADER = 'x-pairlobby-account-token';

export const CREATE_TOKEN_REQUIRED = 'this relay needs its create token to start a room; set PAIRLOBBY_CREATE_TOKEN';

/** One message for a missing and a wrong team token, so the answer says nothing about which. */
export const TEAM_TOKEN_REFUSED = 'this is not the team token for this relay';

export type RateLimit = {perMinute: number};

export type RateDecision = {ok: true} | {ok: false; retryAfterMs: number};

/** Counts attempts per key. A relay with one process keeps them in memory; others store them where all copies see them. */
export interface RateLimiter {
    take(key: string, cost: number, limit: RateLimit): Promise<RateDecision>;
}

export type AdmissionLimits = {
    /** Rooms one address may create a minute. */
    createPerMinutePerAddress: number;
    /** Invite redemptions one address may try a minute; a code that matches nothing counts twice. */
    redeemPerMinutePerAddress: number;
    /** Invite redemptions the whole relay accepts a minute, whoever tries them. */
    redeemPerMinuteGlobal: number;
    /** Team token checks (`GET /api/online/account`) one address may make a minute, counted apart from creating rooms. */
    accountCheckPerMinutePerAddress: number;
};

export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {createPerMinutePerAddress: 10, redeemPerMinutePerAddress: 20, redeemPerMinuteGlobal: 300, accountCheckPerMinutePerAddress: 30};

export type AdmissionOptions = {
    /** When set, creating a room needs this token in the create token header. Joining with an invite never does. */
    createToken?: string;
    /** Absent means no rate limits. */
    limiter?: RateLimiter;
    limits?: Partial<AdmissionLimits>;
    /** The caller's address as the transport saw it; undefined when it cannot tell, and then every such caller shares one count. */
    clientAddress?: (request: Request) => string | undefined;
    /** Callers the limits do not apply to, such as this device on a relay that is not behind a proxy. */
    exempt?: (request: Request) => boolean;
};

type BucketState = {tokens: number; updatedAt: number};

type MemoryRateLimiterOptions = {now?: () => number; maxKeys?: number};

/** Token buckets in memory: each key refills at its per-minute rate and holds at most one minute's worth. */
export function memoryRateLimiter({now = Date.now, maxKeys = 10_000}: MemoryRateLimiterOptions = {}): RateLimiter {
    const buckets = new Map<string, BucketState>();
    return {
        async take(key, cost, {perMinute}) {
            const at = now();
            const perMs = perMinute / 60_000;
            const previous = buckets.get(key);
            const tokens = previous ? Math.min(perMinute, previous.tokens + (at - previous.updatedAt) * perMs) : perMinute;
            if (tokens < cost) {
                buckets.set(key, {tokens, updatedAt: at});
                return {ok: false, retryAfterMs: Math.ceil((cost - tokens) / perMs)};
            }
            buckets.set(key, {tokens: tokens - cost, updatedAt: at});
            if (buckets.size > maxKeys) {
                // A full bucket says nothing a fresh one would not, so forgetting it is free.
                for (const [name, bucket] of buckets) {
                    if (bucket.tokens + (at - bucket.updatedAt) * perMs >= perMinute) {
                        buckets.delete(name);
                    }
                }
            }
            return {ok: true};
        }
    };
}

/** Builds the checks a router runs before creating a room or redeeming an invite. */
export function createAdmission(options: AdmissionOptions) {
    const limits = {...DEFAULT_ADMISSION_LIMITS, ...options.limits};
    const tokenDigest = options.createToken ? hashCredential(options.createToken) : null;
    const address = (request: Request) => options.clientAddress?.(request) ?? 'unknown';
    const take = async (request: Request, key: string, cost: number, limit: RateLimit) => {
        if (!options.limiter || options.exempt?.(request)) {
            return;
        }
        const decision = await options.limiter.take(key, cost, limit);
        if (!decision.ok) {
            throw new ProtocolError('rate_limited', 'too many attempts from here; wait a moment and try again', {retryAfterMs: decision.retryAfterMs});
        }
    };
    /** Whether the request carries the create token, compared as digests so the time taken says nothing about it. */
    const tokenMatches = async (request: Request): Promise<boolean> => {
        const offered = request.headers.get(CREATE_TOKEN_HEADER);
        return Boolean(tokenDigest && offered && digestsEqual(await hashCredential(offered), await tokenDigest));
    };
    return {
        tokenMatches,
        /** Refuses a room creation without the create token, then counts it against the caller. */
        async beforeCreate(request: Request): Promise<void> {
            if (tokenDigest && !(await tokenMatches(request))) {
                throw new ProtocolError('unauthorized', CREATE_TOKEN_REQUIRED);
            }
            await take(request, `create:address:${address(request)}`, 1, {perMinute: limits.createPerMinutePerAddress});
        },
        /**
         * The team token check behind token-mode login: counted first, in its own bucket so
         * guessing cannot spend the create budget, then refused the same way whether the
         * token is missing or wrong.
         */
        async beforeAccountCheck(request: Request): Promise<void> {
            await take(request, `account-check:address:${address(request)}`, 1, {perMinute: limits.accountCheckPerMinutePerAddress});
            if (!(await tokenMatches(request))) {
                throw new ProtocolError('unauthorized', TEAM_TOKEN_REFUSED);
            }
        },
        /** Counts an invite redemption against the caller and the whole relay, before the code is looked up. */
        async beforeRedeem(request: Request): Promise<void> {
            await take(request, `redeem:address:${address(request)}`, 1, {perMinute: limits.redeemPerMinutePerAddress});
            await take(request, 'redeem:global', 1, {perMinute: limits.redeemPerMinuteGlobal});
        },
        /** A code that matched nothing costs the caller once more, so guessing is slower than joining. */
        async afterUnknownInvite(request: Request): Promise<void> {
            if (!options.limiter || options.exempt?.(request)) {
                return;
            }
            await options.limiter.take(`redeem:address:${address(request)}`, 1, {perMinute: limits.redeemPerMinutePerAddress});
        }
    };
}

export type Admission = ReturnType<typeof createAdmission>;

/**
 * The client address a trusted proxy reports in `header`. The right-most entry of a
 * list is the one the proxy itself added; anything to its left came from the caller.
 */
export function proxiedAddress(request: Request, header: string): string | undefined {
    const value = request.headers.get(header);
    const last = value?.split(',').map((part) => part.trim()).filter(Boolean).at(-1);
    return last || undefined;
}

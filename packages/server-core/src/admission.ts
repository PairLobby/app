//! Who may start rooms and how fast anyone may try invite codes: the checks a relay
//! reachable from a network needs before a request reaches a room. Shared by every
//! relay so the rules and their wording are the same on each.

import {ProtocolError, digestsEqual, hashCredential} from '@pairlobby/protocol';

import type {RequestContext} from './ports.js';

/** The header that carries a relay's create token, the same one a hosted account token travels in. */
export const CREATE_TOKEN_HEADER = 'x-pairlobby-account-token';

export const CREATE_TOKEN_REQUIRED = 'this relay needs its create token to start a room; set PAIRLOBBY_CREATE_TOKEN';

/** One message for a missing and a wrong team token, so the answer says nothing about which. */
export const TEAM_TOKEN_REFUSED = 'this is not the team token for this relay';

/** The same, on a relay where people log in with their own tokens. */
export const LOGIN_TOKEN_REFUSED = 'this token does not log in to this relay';

/** A person on a relay with personal tokens. */
export type RelayMember = {handle: string; name?: string};

/** The member whose personal token has this SHA-256 digest, or null. */
export type MemberLookup = (digest: string) => Promise<RelayMember | null>;

/** Who a token in the create token header stands for: the team, or one member. */
type Caller = {kind: 'team'} | {kind: 'member'; member: RelayMember};

/** A rate, and how many may come at once; without `burst`, one minute's worth. */
export type RateLimit = {perMinute: number; burst?: number};

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
    /** Directory reads one member may make a minute. */
    directoryPerMinutePerMember: number;
    /** Contacts one member may start a minute. */
    contactPerMinutePerMember: number;
    /** Contacts one listing may receive an hour, from everyone together. */
    contactPerHourPerListing: number;
};

export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {createPerMinutePerAddress: 10, redeemPerMinutePerAddress: 20, redeemPerMinuteGlobal: 300, accountCheckPerMinutePerAddress: 30, directoryPerMinutePerMember: 60, contactPerMinutePerMember: 10, contactPerHourPerListing: 30};

export type AdmissionOptions = {
    /** When set, creating a room needs this token in the create token header. Joining with an invite never does. */
    createToken?: string;
    /** Personal tokens: each creates rooms like the create token, logs in as its member, and names that member on the rooms they create and join. */
    members?: MemberLookup;
    /** Whether the create token also logs people in, beside personal tokens. Default true; false leaves it for creating rooms only. */
    teamTokenLogin?: boolean;
    /** Absent means no rate limits. */
    limiter?: RateLimiter;
    limits?: Partial<AdmissionLimits>;
    /**
     * The header a proxy in front of the relay puts the caller's address in, such as `x-forwarded-for`.
     * Absent means no such header is read, whoever sends it: a caller could write it themselves.
     */
    trustedProxyHeader?: string;
    /** The caller's address; defaults to the proxy header when one is trusted, else the connection's address. Undefined makes every such caller share one count. */
    clientAddress?: (request: Request, context: RequestContext) => string | undefined;
    /** Callers the limits do not apply to, such as this device on a relay that is not behind a proxy. */
    exempt?: (request: Request, context: RequestContext) => boolean;
};

export type BucketState = {tokens: number; updatedAt: number};
export type BucketDecision = {state: BucketState; fullAt: number; decision: RateDecision};
type StoredBucket = {state: BucketState; fullAt: number};

/** The same pure token-bucket decision for memory and durable stores. Persist state atomically before returning decision. */
export function takeTokens(previous: BucketState | undefined, cost: number, {perMinute, burst = perMinute}: RateLimit, at: number): BucketDecision {
    const perMs = perMinute / 60_000;
    at = Math.max(at, previous?.updatedAt ?? at);
    const tokens = previous ? Math.min(burst, previous.tokens + Math.max(0, at - previous.updatedAt) * perMs) : burst;
    const ok = tokens >= cost;
    const state = {tokens: ok ? tokens - cost : tokens, updatedAt: at};
    return {state, fullAt: at + Math.ceil((burst - state.tokens) / perMs), decision: ok ? {ok: true} : {ok: false, retryAfterMs: Math.ceil((cost - tokens) / perMs)}};
}

type MemoryRateLimiterOptions = {now?: () => number; maxKeys?: number};

/** Token buckets in memory: each key refills at its per-minute rate and holds at most its burst, one minute's worth unless said. */
export function memoryRateLimiter({now = Date.now, maxKeys = 10_000}: MemoryRateLimiterOptions = {}): RateLimiter {
    const buckets = new Map<string, StoredBucket>();
    return {
        async take(key, cost, {perMinute, burst = perMinute}) {
            const at = now();
            if (!buckets.has(key) && buckets.size >= maxKeys) {
                for (const [name, bucket] of buckets) {
                    if (bucket.fullAt <= at) {
                        buckets.delete(name);
                    }
                }
                if (buckets.size >= maxKeys) {
                    const next = Math.min(...[...buckets.values()].map((bucket) => bucket.fullAt));
                    return {ok: false, retryAfterMs: Math.max(1, next - at)};
                }
            }
            const {state, fullAt, decision} = takeTokens(buckets.get(key)?.state, cost, {perMinute, burst}, at);
            buckets.set(key, {state, fullAt});
            return decision;
        }
    };
}

/** Builds the checks a router runs before creating a room or redeeming an invite. */
export function createAdmission(options: AdmissionOptions) {
    const limits = {...DEFAULT_ADMISSION_LIMITS, ...options.limits};
    const tokenDigest = options.createToken ? hashCredential(options.createToken) : null;
    const header = options.trustedProxyHeader;
    const clientAddress = options.clientAddress ?? ((request: Request, context: RequestContext) => (header ? proxiedAddress(request, header) : undefined) ?? context.peerAddress);
    const address = (request: Request, context: RequestContext) => clientAddress(request, context) ?? 'unknown';
    const take = async (request: Request, context: RequestContext, key: string, cost: number, limit: RateLimit) => {
        if (!options.limiter || options.exempt?.(request, context)) {
            return;
        }
        const decision = await options.limiter.take(key, cost, limit);
        if (!decision.ok) {
            throw new ProtocolError('rate_limited', 'too many attempts from here; wait a moment and try again', {retryAfterMs: decision.retryAfterMs});
        }
    };
    const tokenRequired = tokenDigest !== null || options.members !== undefined;
    /** Who the token in the request stands for; the create token is compared as digests so the time taken says nothing about it. */
    const caller = async (request: Request): Promise<Caller | null> => {
        const offered = request.headers.get(CREATE_TOKEN_HEADER);
        if (!offered || (!tokenDigest && !options.members)) {
            return null;
        }
        const digest = await hashCredential(offered);
        if (tokenDigest && digestsEqual(digest, await tokenDigest)) {
            return {kind: 'team'};
        }
        const member = await options.members?.(digest);
        return member ? {kind: 'member', member} : null;
    };
    const tokenMatches = async (request: Request): Promise<boolean> => (await caller(request))?.kind === 'team';
    return {
        tokenMatches,
        /** Creating a room needs the create token or a personal token here. */
        createTokenRequired: tokenRequired,
        /** People hold their own tokens here, so rooms and participants can name a member. */
        memberTokens: options.members !== undefined,
        /** The member a request's personal token names, or null; refuses nothing. */
        async member(request: Request): Promise<RelayMember | null> {
            const found = await caller(request);
            return found?.kind === 'member' ? found.member : null;
        },
        /** Refuses a room creation without a token that may create rooms, counts it against the caller, and returns the member creating it. */
        async beforeCreate(request: Request, context: RequestContext = {}): Promise<RelayMember | null> {
            const found = await caller(request);
            if (tokenRequired && !found) {
                throw new ProtocolError('unauthorized', CREATE_TOKEN_REQUIRED);
            }
            await take(request, context, `create:address:${address(request, context)}`, 1, {perMinute: limits.createPerMinutePerAddress});
            return found?.kind === 'member' ? found.member : null;
        },
        /**
         * The token check behind token-mode login: counted first, in its own bucket so
         * guessing cannot spend the create budget, then refused the same way whether the
         * token is missing or wrong. Returns the member, or null for the team token.
         */
        async beforeAccountCheck(request: Request, context: RequestContext = {}): Promise<RelayMember | null> {
            await take(request, context, `account-check:address:${address(request, context)}`, 1, {perMinute: limits.accountCheckPerMinutePerAddress});
            const found = await caller(request);
            if (!found || (found.kind === 'team' && options.teamTokenLogin === false)) {
                throw new ProtocolError('unauthorized', options.members ? LOGIN_TOKEN_REFUSED : TEAM_TOKEN_REFUSED);
            }
            return found.kind === 'member' ? found.member : null;
        },
        /** Counts an invite redemption against the caller and the whole relay, before the code is looked up. */
        async beforeRedeem(request: Request, context: RequestContext = {}): Promise<void> {
            await take(request, context, `redeem:address:${address(request, context)}`, 1, {perMinute: limits.redeemPerMinutePerAddress});
            await take(request, context, 'redeem:global', 1, {perMinute: limits.redeemPerMinuteGlobal});
        },
        /** Counts a directory read against the member making it. */
        async beforeDirectory(request: Request, context: RequestContext, member: RelayMember): Promise<void> {
            await take(request, context, `directory:member:${member.handle}`, 1, {perMinute: limits.directoryPerMinutePerMember});
        },
        /** Counts a contact against the member starting it and the listing it reaches. */
        async beforeContact(request: Request, context: RequestContext, member: RelayMember, listingId: string): Promise<void> {
            await take(request, context, `contact:member:${member.handle}`, 1, {perMinute: limits.contactPerMinutePerMember});
            await take(request, context, `contact:listing:${listingId}`, 1, {perMinute: limits.contactPerHourPerListing / 60, burst: limits.contactPerHourPerListing});
        },
        /** A code that matched nothing costs the caller once more, so guessing is slower than joining. */
        async afterUnknownInvite(request: Request, context: RequestContext = {}): Promise<void> {
            if (!options.limiter || options.exempt?.(request, context)) {
                return;
            }
            await options.limiter.take(`redeem:address:${address(request, context)}`, 1, {perMinute: limits.redeemPerMinutePerAddress});
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

import {emitKeypressEvents} from 'node:readline';
import {LocalStore} from '@pairlobby/client';
import {normalizeInviteCode} from '@pairlobby/protocol';
import {UsageError} from './context.js';
import {DeviceLoginUnavailable, loginInBrowser, revokeToken} from './device-login.js';
import {DEFAULT_VERIFY, readDiscovery} from './discovery.js';
import type {ProbeResult} from './discovery.js';
import {BUILT_IN_ORIGIN, activeEndpoint, isSaved, normalizeOrigin, relayBelongs, tokenMayGo, updateEndpoint} from './endpoints.js';
import type {Endpoint} from './endpoints.js';

type Keypress = {name?: string; ctrl?: boolean};

/** The login endpoint's origin for this command; see `activeEndpoint` for the order. */
export function onlineOrigin(store: LocalStore): string {
    return activeEndpoint(store).origin;
}

let warnedUnscoped = false;

/**
 * PAIRLOBBY_ACCOUNT_TOKEN, when it may be used for this endpoint: always for
 * pairlobby.com, with PAIRLOBBY_ONLINE_ORIGIN, or when PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN
 * names this origin. Otherwise one deployment's token could reach another.
 */
function environmentToken(endpoint: Endpoint): string | undefined {
    const token = process.env['PAIRLOBBY_ACCOUNT_TOKEN'];
    if (!token) {
        return undefined;
    }
    const scoped = process.env['PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN'];
    if (endpoint.origin === BUILT_IN_ORIGIN || process.env['PAIRLOBBY_ONLINE_ORIGIN'] || (scoped && normalizeOrigin(scoped, 'PAIRLOBBY_ACCOUNT_TOKEN_ORIGIN') === endpoint.origin)) {
        return token;
    }
    if (!warnedUnscoped) {
        warnedUnscoped = true;
        process.stderr.write(`PAIRLOBBY_ACCOUNT_TOKEN ignored: it is not scoped to ${endpoint.origin}\n`);
    }
    return undefined;
}

export function accountToken(store: LocalStore, endpoint = activeEndpoint(store)): string | undefined {
    return environmentToken(endpoint) ?? store.credential('online-account', endpoint.origin);
}

/** The saved token for a relay on the active endpoint's own origin or one it declared; never any other origin. */
export function accountTokenFor(store: LocalStore, serverUrl: string): string | undefined {
    const endpoint = activeEndpoint(store);
    return tokenMayGo(endpoint, serverUrl) ? accountToken(store, endpoint) : undefined;
}

/**
 * The token `create` sends to a relay: PAIRLOBBY_CREATE_TOKEN, which names the relay's own create token,
 * or else the active endpoint's login when the relay is one of its own. Never an unscoped PAIRLOBBY_ACCOUNT_TOKEN.
 */
export function createTokenFor(store: LocalStore, serverUrl: string): string | undefined {
    return process.env['PAIRLOBBY_CREATE_TOKEN'] || accountTokenFor(store, serverUrl);
}
type RequestBody = {method: 'POST' | 'PUT'; body: unknown};

/** Rereads a saved endpoint's discovery document and keeps what it now says. Null when there is none to read. */
export async function refreshEndpoint(store: LocalStore, endpoint: Endpoint): Promise<{endpoint: Endpoint; discovery: ProbeResult} | null> {
    if (!isSaved(store, endpoint)) {
        return null;
    }
    const discovery = await readDiscovery(endpoint.origin).catch(() => null);
    if (!discovery) {
        return null;
    }
    const updated = updateEndpoint(store, endpoint.label, {name: discovery.name, loginMode: discovery.loginMode, relayOrigins: discovery.relayOrigins});
    return updated ? {endpoint: updated, discovery} : null;
}

/** Commands that need an account service. A relay with token login offers `create online` and nothing else; one with no login offers none. */
export function requireAccountApi(store: LocalStore, command: string): void {
    const endpoint = activeEndpoint(store);
    if (endpoint.loginMode === 'browser' || (endpoint.loginMode === 'token' && command === 'create online')) {
        return;
    }
    const instead = endpoint.loginMode === 'token' ? 'Use an invite code or pairlobby create online.' : 'Use an invite code, or pairlobby create.';
    throw new UsageError(`This deployment (${endpoint.name}) does not offer ${command}. ${instead}`);
}

async function request<T>(endpoint: Endpoint, path: string, token?: string, send?: RequestBody, store?: LocalStore): Promise<T> {
    const response = await fetch(endpoint.origin + path, {...(send ? {method: send.method, body: JSON.stringify(send.body)} : {}), headers: {...(token ? {'x-pairlobby-account-token': token} : {}), ...(send ? {'content-type': 'application/json'} : {})}, redirect: 'error', signal: AbortSignal.timeout(15000)});
    if (response.status === 404 && store) {
        // A deployment that changed how it logs people in says so in its discovery document.
        await refreshEndpoint(store, endpoint);
    }
    const data = (await response.json().catch(() => ({}))) as {error?: {message?: string}};
    if (!response.ok) {
        throw new UsageError(data.error?.message ?? 'Online service unavailable');
    }
    return data as T;
}
export async function onlineAccount(store: LocalStore) {
    const endpoint = activeEndpoint(store);
    const result = await request<{email: string | null; userId: string; server: string; handle?: string | null}>(endpoint, '/api/online/account', accountToken(store, endpoint), undefined, store);
    validateRelay(endpoint, result.server);
    return result;
}

function requireToken(store: LocalStore, purpose: string): string {
    const token = accountToken(store);
    if (!token) {
        throw new UsageError(`Run pairlobby login first to ${purpose}`);
    }
    return token;
}

/** Sets this account's handle, the name others invite it by. The service enforces the rules and answers with the stored form. */
export async function setHandle(store: LocalStore, handle: string): Promise<string> {
    return (await request<{handle: string}>(activeEndpoint(store), '/api/online/handle', requireToken(store, 'choose a handle'), {method: 'PUT', body: {handle}}, store)).handle;
}

/** An invitation this account received and has not answered. `guest` is a read-only observer. */
export type ReceivedInvitation = {id: string; roomId: string; roomName: string; invitedBy: string; role: 'member' | 'guest'; agents: number; createdAt: number; expiresAt: number};

export async function receivedInvitations(store: LocalStore): Promise<ReceivedInvitation[]> {
    return (await request<{invitations: ReceivedInvitation[]}>(activeEndpoint(store), '/api/online/invitations', requireToken(store, 'see your invitations'), undefined, store)).invitations;
}

export type AcceptedInvitation = {roomId: string; roomName: string; role: 'member' | 'guest'; server: string};

/** Accepts an invitation, which is what puts this account on the room's allowlist. Joining is a separate step. */
export async function acceptInvitation(store: LocalStore, id: string): Promise<AcceptedInvitation> {
    const endpoint = activeEndpoint(store);
    const result = await request<AcceptedInvitation>(endpoint, `/api/online/invitations/${id}/accept`, requireToken(store, 'accept an invitation'), {method: 'POST', body: {}});
    return {...result, server: validateRelay(endpoint, result.server)};
}

export async function declineInvitation(store: LocalStore, id: string): Promise<void> {
    await request(activeEndpoint(store), `/api/online/invitations/${id}/decline`, requireToken(store, 'decline an invitation'), {method: 'POST', body: {}});
}

/** Picks one invitation by its id, room id, or room name, and says so when a name is shared. */
export function matchInvitation(invitations: ReceivedInvitation[], reference: string): ReceivedInvitation {
    const exact = invitations.find((invitation) => invitation.id === reference || invitation.roomId === reference);
    if (exact) {
        return exact;
    }
    const byName = invitations.filter((invitation) => invitation.roomName.toLowerCase() === reference.toLowerCase());
    if (byName.length === 1) {
        return byName[0]!;
    }
    if (byName.length > 1) {
        throw new UsageError(`Several invitations are to rooms called "${reference}"; pass a room id: ${byName.map((invitation) => invitation.roomId).join(', ')}`);
    }
    throw new UsageError(`No unanswered invitation to "${reference}"; run pairlobby invitations to list them`);
}
export type OnlineRoom = {
    roomId: string;
    name: string;
    createdAt: number;
    expiresAt: number | null;
    lifecycle: string;
    private: boolean;
    owner: boolean;
    participants: OnlineRoomParticipant[];
    latestSeq: number;
    /** The relay this room lives on. A room someone invited you into is on their relay, not yours. */
    server: string;
    /** True for a room in someone else's workspace that this account accepted an invitation to. */
    shared?: boolean;
};

type OnlineRoomParticipant = {displayName: string; kind: string};

export type OnlineRooms = {server: string; rooms: OnlineRoom[]};

/** Rooms this account owns or is allowed into, from whichever device asks. */
export async function onlineRooms(store: LocalStore): Promise<OnlineRooms> {
    const endpoint = activeEndpoint(store);
    const result = await request<{server: string; rooms: Omit<OnlineRoom, 'server'>[]; shared?: OnlineRoom[]}>(endpoint, '/api/online/rooms', requireToken(store, 'see your account rooms'), undefined, store);
    const server = validateRelay(endpoint, result.server);
    // A service from before invitations sends no shared rooms.
    const shared = (result.shared ?? []).map((room) => ({...room, server: validateRelay(endpoint, room.server), shared: true}));
    return {server, rooms: [...result.rooms.map((room) => ({...room, server})), ...shared]};
}

/** An online key is dash-grouped, like ABCD-EFGH-JKMN; anything else names a room. */
export function isOnlineKey(value: string): boolean {
    return /^[0-9A-Za-z]{4}(-[0-9A-Za-z]{4}){1,2}$/.test(value) && normalizeInviteCode(value) !== null;
}

export function matchOnlineRoom(rooms: OnlineRoom[], reference: string): OnlineRoom {
    const byId = rooms.find((room) => room.roomId === reference);
    if (byId) {
        return byId;
    }
    const byName = rooms.filter((room) => room.name.toLowerCase() === reference.toLowerCase());
    if (byName.length === 1) {
        return byName[0]!;
    }
    if (byName.length > 1) {
        throw new UsageError(`"${reference}" matches several of your rooms: ${byName.map((room) => room.roomId).join(', ')}; pass the room id`);
    }
    throw new UsageError(`None of your account's rooms is called "${reference}"; run pairlobby find online to list them`);
}

export async function resolveOnlineKey(store: LocalStore, code: string): Promise<string> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) {
        throw new UsageError('Invalid online room key');
    }
    const endpoint = activeEndpoint(store);
    const result = await request<{server: string}>(endpoint, '/api/online/invites/' + normalized, accountToken(store, endpoint), undefined, store);
    return validateRelay(endpoint, result.server);
}

/** A room address the service returned, accepted only on this endpoint's own relays (for pairlobby.com, under `/relay/`). */
function validateRelay(endpoint: Endpoint, value: string): string {
    if (!relayBelongs(endpoint, value)) {
        throw new UsageError('The service returned an invalid room address');
    }
    return new URL(value).href;
}
export type LoginOptions = {
    /** Paste a token from the account page instead of approving in the browser. */
    paste?: boolean;
    /** False prints the approval address without opening a browser. */
    openBrowser?: boolean;
};

async function promptForToken(endpoint: Endpoint, help?: string): Promise<string> {
    if (!process.stdin.isTTY) {
        throw new UsageError('Set PAIRLOBBY_ACCOUNT_TOKEN or run pairlobby login in a terminal');
    }
    // The account page exists on pairlobby.com; another deployment says where its tokens come from.
    process.stderr.write(endpoint.hosted ? `Create an account token at ${endpoint.origin}/account.\nPaste account token (hidden): ` : `${help ? `${help}\n` : ''}Paste the token for ${endpoint.name} (hidden): `);
    return new Promise<string>((resolve, reject) => {
        let value = '';
        const raw = process.stdin.isRaw;
        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        function finish(error?: Error) {
            process.stdin.off('keypress', press);
            process.stdin.setRawMode(raw);
            process.stdin.pause();
            process.stderr.write('\n');
            error ? reject(error) : resolve(value.trim());
        }
        function press(text: string, key: Keypress) {
            if (key.ctrl && key.name === 'c') {
                return finish(new UsageError('Login cancelled'));
            }
            if (key.name === 'return' || key.name === 'enter') {
                return finish();
            }
            if (key.name === 'backspace') {
                value = value.slice(0, -1);
            } else if (!key.ctrl && text) {
                value += text.replace(/[\x00-\x1f\x7f]/g, '');
            }
        }
        process.stdin.on('keypress', press);
    });
}

/**
 * Signs this device in to the active endpoint and returns the account's email, or
 * null for a team token, which stands for no one in particular. A token-mode
 * deployment is asked for its team token; one with no login refuses.
 */
export async function loginOnline(store: LocalStore, options: LoginOptions = {}): Promise<string | null> {
    let endpoint = activeEndpoint(store);
    const refreshed = await refreshEndpoint(store, endpoint);
    endpoint = refreshed?.endpoint ?? endpoint;
    if (endpoint.loginMode === 'none') {
        throw new UsageError(`This deployment (${endpoint.name}) has no login. Use an invite code, or pairlobby create --server <relay>.`);
    }
    let token = environmentToken(endpoint);
    if (endpoint.loginMode === 'token') {
        token ??= await promptForToken(endpoint, refreshed?.discovery.tokenHelp);
    } else if (!token && options.paste) {
        token = await promptForToken(endpoint);
    } else if (!token) {
        try {
            token = await loginInBrowser({origin: endpoint.origin, openBrowser: options.openBrowser ?? process.stdin.isTTY === true});
        } catch (error) {
            if (!(error instanceof DeviceLoginUnavailable)) {
                throw error;
            }
            process.stderr.write('This service does not offer browser login yet; paste a token instead.\n');
            token = await promptForToken(endpoint);
        }
    }
    if (!token) {
        throw new UsageError('Account token required');
    }
    const verify = endpoint.loginMode === 'token' ? refreshed?.discovery.verify ?? DEFAULT_VERIFY : DEFAULT_VERIFY;
    const account = await request<{email?: string | null}>(endpoint, verify, token);
    store.putCredential('online-account', endpoint.origin, token);
    return account.email ?? null;
}

export type LogoutResult = {removed: boolean; revoked: boolean | null};

/**
 * Forgets this origin's saved login, keeping other origins', and revokes it on the
 * service; null means nothing was asked to revoke. A team token is only forgotten:
 * no laptop may revoke the token the whole team shares.
 */
export async function logoutOnline(store: LocalStore): Promise<LogoutResult> {
    const {origin, loginMode} = activeEndpoint(store);
    const saved = store.credential('online-account', origin);
    const revoked = saved && loginMode === 'browser' ? await revokeToken(origin, saved) : null;
    store.forgetCredential('online-account', origin);
    return {removed: saved !== undefined, revoked};
}

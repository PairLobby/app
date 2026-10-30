//! The checks every PairLobby relay must pass, run over HTTP with the real client,
//! so the Node relay, the Durable Object relay and any other implementation are held
//! to one contract. A check the relay says it cannot do (a feature it does not list)
//! is skipped, not failed; anything else that differs is a failure.

import {PairLobbyClient} from '@pairlobby/client';
import type {JoinedRoom} from '@pairlobby/client';
import {PROTOCOL_VERSION_HEADER, ProtocolError, newId} from '@pairlobby/protocol';
import type {ErrorCode, ServerDescription} from '@pairlobby/protocol';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export type CheckResult = {id: string; title: string; status: CheckStatus; detail?: string; ms: number};

export type ConformanceReport = {relay: string; description: ServerDescription | null; results: CheckResult[]; passed: boolean};

export type ConformanceOptions = {
    /** The relay's base URL, such as `http://127.0.0.1:8790`. */
    relay: string;
    /** The relay's create token, when it needs one. */
    createToken?: string | undefined;
    /** Only these checks, by id. */
    only?: string[];
};

type CheckContext = {relay: string; description: ServerDescription | null; owner: () => PairLobbyClient; stranger: () => PairLobbyClient};

type Check = {id: string; title: string; run: (context: CheckContext) => Promise<string | void>};

class Skip extends Error {}

const human = {displayName: 'conformance-owner', kind: 'human' as const};
const agent = {displayName: 'conformance-agent', kind: 'agent' as const};

function fail(message: string): never {
    throw new Error(message);
}

function needFeature(context: CheckContext, feature: string): void {
    if (!context.description?.features?.includes(feature)) {
        throw new Skip(`the relay does not list ${feature}`);
    }
}

async function expectCode(action: Promise<unknown>, code: ErrorCode): Promise<void> {
    try {
        await action;
    } catch (error) {
        if (error instanceof ProtocolError && error.code === code) {
            return;
        }
        fail(`expected ${code}, got ${error instanceof ProtocolError ? error.code : String(error)}`);
    }
    fail(`expected ${code}, but the request succeeded`);
}

/** A room with its owner and one joined agent, deleted again by the caller. */
async function pair(context: CheckContext): Promise<{owner: PairLobbyClient; roomId: string; ownerCredential: string; controllerCredential: string; guest: JoinedRoom; guestClient: PairLobbyClient}> {
    const owner = context.owner();
    const created = await owner.createRoom(`conformance-${newId('event').slice(-6)}`, human);
    const guestClient = context.stranger();
    const guest = await guestClient.redeemInvite(created.invite.code, agent);
    return {owner, roomId: created.roomId, ownerCredential: created.participantCredential, controllerCredential: created.controllerCredential, guest, guestClient};
}

async function message(client: PairLobbyClient, roomId: string, credential: string, recipientId: string, text: string): Promise<string> {
    return (await client.send(roomId, credential, {type: 'message', recipientId, payload: {text, priority: 'normal'}, idempotencyKey: newId('event')})).event.eventId;
}

export const CHECKS: Check[] = [
    {
        id: 'describes-itself',
        title: 'GET /v1/server describes the relay',
        async run(context) {
            if (!context.description) {
                fail('no description at /v1/server');
            }
            if (context.description.protocol !== 1) {
                fail(`protocol ${String(context.description.protocol)}, expected 1`);
            }
            return `transport ${context.description.transport?.live ?? 'not reported'}; features ${context.description.features?.join(', ') ?? 'none'}`;
        }
    },
    {
        id: 'health',
        title: 'GET /health answers ready',
        async run(context) {
            const response = await fetch(`${context.relay}/health`);
            const body = (await response.json().catch(() => null)) as {ready?: unknown} | null;
            if (response.status !== 200 || body?.ready !== true) {
                fail(`answered ${response.status} ${JSON.stringify(body)}`);
            }
        }
    },
    {
        id: 'protocol-version',
        title: 'a request for another protocol version is refused',
        async run(context) {
            const response = await fetch(`${context.relay}/v1/rooms`, {method: 'POST', headers: {[PROTOCOL_VERSION_HEADER]: '999', 'content-type': 'application/json'}, body: '{}'});
            const body = (await response.json().catch(() => null)) as {error?: {code?: string}} | null;
            if (response.status !== 400 || body?.error?.code !== 'protocol_version_unsupported') {
                fail(`answered ${response.status} ${body?.error?.code ?? ''}`);
            }
        }
    },
    {
        id: 'create-token',
        title: 'creating a room needs the create token, joining does not',
        async run(context) {
            needFeature(context, 'create-token');
            await expectCode(context.stranger().createRoom('no token', human), 'unauthorized');
            const {owner, roomId, controllerCredential} = await pair(context);
            await owner.delete(roomId, controllerCredential);
        }
    },
    {
        id: 'create-join-send-read',
        title: 'create, join with an invite, send, read and see the request',
        async run(context) {
            const {owner, roomId, ownerCredential, controllerCredential, guest, guestClient} = await pair(context);
            if (guest.roomId !== roomId) {
                fail('the invite joined a different room');
            }
            const eventId = await message(owner, roomId, ownerCredential, guest.participantId, 'Please review');
            const page = await guestClient.readEvents(roomId, guest.participantCredential, 0);
            if (!page.events.some((event) => event.eventId === eventId)) {
                fail('the guest does not see the message');
            }
            const pending = await guestClient.pendingRequests(roomId, guest.participantCredential, guest.participantId);
            if (!pending.some((request) => request.eventId === eventId)) {
                fail('the message is not a pending request for the guest');
            }
            await owner.delete(roomId, controllerCredential);
        }
    },
    {
        id: 'receipt-and-reply',
        title: 'an acknowledgement records receipt and a reply resolves the request',
        async run(context) {
            const {owner, roomId, ownerCredential, controllerCredential, guest, guestClient} = await pair(context);
            const eventId = await message(owner, roomId, ownerCredential, guest.participantId, 'Ping');
            await guestClient.acknowledgeMessage(roomId, guest.participantCredential, eventId);
            if ((await owner.request(roomId, ownerCredential, eventId)).receivedAt === null) {
                fail('no receipt after the acknowledgement');
            }
            await guestClient.reply(roomId, guest.participantCredential, eventId, 'Pong');
            const answered = await owner.request(roomId, ownerCredential, eventId);
            if (answered.respondedAt === null || answered.responseText !== 'Pong') {
                fail('the reply did not resolve the request');
            }
            if ((await guestClient.pendingRequests(roomId, guest.participantCredential, guest.participantId)).some((request) => request.eventId === eventId)) {
                fail('the answered request is still pending');
            }
            await owner.delete(roomId, controllerCredential);
        }
    },
    {
        id: 'read-paging',
        title: 'reads page with after, limit and hasMore',
        async run(context) {
            const {owner, roomId, ownerCredential, controllerCredential, guest, guestClient} = await pair(context);
            const sent = [];
            for (const text of ['one', 'two', 'three']) {
                sent.push(await message(owner, roomId, ownerCredential, guest.participantId, text));
            }
            const seen: string[] = [];
            let after = 0;
            for (let pages = 0; pages < 50; pages++) {
                const page = await guestClient.readEvents(roomId, guest.participantCredential, after, 1);
                if (page.events.length > 1) {
                    fail('a page held more than its limit');
                }
                seen.push(...page.events.map((event) => event.eventId));
                after = page.events.at(-1)?.seq ?? after;
                if (!page.hasMore) {
                    break;
                }
            }
            if (!sent.every((eventId) => seen.includes(eventId))) {
                fail('paging one at a time missed a message');
            }
            await owner.delete(roomId, controllerCredential);
        }
    },
    {
        id: 'refusals',
        title: 'an unknown invite, a wrong credential and a deleted room are refused by code',
        async run(context) {
            await expectCode(context.stranger().redeemInvite('ZZZZ-ZZZZ', agent), 'invite_unknown');
            const {owner, roomId, ownerCredential, controllerCredential} = await pair(context);
            await expectCode(owner.snapshot(roomId, `${ownerCredential.slice(0, -4)}xxxx`), 'unauthorized');
            await owner.delete(roomId, controllerCredential);
            await expectCode(owner.snapshot(roomId, ownerCredential), 'room_not_found');
        }
    },
    {
        id: 'files',
        title: 'a file goes up, travels with a message and comes back intact',
        async run(context) {
            needFeature(context, 'files');
            const {owner, roomId, ownerCredential, controllerCredential, guest, guestClient} = await pair(context);
            const bytes = new Uint8Array(300_000).map((_, index) => (index * 31) & 0xff);
            const file = await owner.uploadFile(roomId, ownerCredential, 'sample.bin', bytes);
            await owner.send(roomId, ownerCredential, {type: 'message', recipientId: guest.participantId, payload: {text: 'The file', priority: 'normal', attachments: [file]}, idempotencyKey: newId('event')});
            const downloaded = await guestClient.downloadFile(roomId, guest.participantCredential, file.fileId);
            if (downloaded.byteLength !== bytes.byteLength || downloaded.findIndex((byte, index) => byte !== bytes[index]) !== -1) {
                fail('the downloaded file differs from the upload');
            }
            await owner.delete(roomId, controllerCredential);
        }
    },
    {
        id: 'receipt-watermark',
        title: 'a watermark marks requests received, reads return it, and in watermark mode it adds no event',
        async run(context) {
            needFeature(context, 'receipt-watermark');
            const {owner, roomId, ownerCredential, controllerCredential, guest, guestClient} = await pair(context);
            const first = await message(owner, roomId, ownerCredential, guest.participantId, 'First');
            const second = await message(owner, roomId, ownerCredential, guest.participantId, 'Second');
            const secondSeq = (await owner.readEvents(roomId, ownerCredential, 0)).events.find((event) => event.eventId === second)!.seq;
            const before = (await owner.readEvents(roomId, ownerCredential, 0, 200, {receiptsAfter: 0})).latestSeq;
            const moved = await guestClient.postReceipt(roomId, guest.participantCredential, secondSeq);
            if (moved.throughSeq !== secondSeq) {
                fail(`the watermark stopped at ${moved.throughSeq}, not ${secondSeq}`);
            }
            const backwards = await guestClient.postReceipt(roomId, guest.participantCredential, 1);
            if (backwards.throughSeq !== secondSeq) {
                fail('a lower watermark moved it back');
            }
            for (const eventId of [first, second]) {
                if ((await owner.request(roomId, ownerCredential, eventId)).receivedAt === null) {
                    fail('a request at or before the watermark is not marked received');
                }
            }
            const page = await owner.readEvents(roomId, ownerCredential, 0, 200, {receiptsAfter: 0});
            if (!page.receipts?.some((mark) => mark.participantId === guest.participantId && mark.throughSeq === secondSeq)) {
                fail('a read asking for receipts did not return the watermark');
            }
            if (context.description?.receiptMode === 'watermark' && page.latestSeq !== before) {
                fail(`a watermark added ${page.latestSeq - before} event(s)`);
            }
            await owner.delete(roomId, controllerCredential);
            return context.description?.receiptMode ? `mode ${context.description.receiptMode}` : undefined;
        }
    },
    {
        id: 'long-poll',
        title: 'a waiting read answers when a message arrives, and empty at its deadline',
        async run(context) {
            if (context.description?.transport?.live !== 'long-poll') {
                throw new Skip('the relay does not describe long-poll');
            }
            const {owner, roomId, ownerCredential, controllerCredential, guest, guestClient} = await pair(context);
            const latest = (await guestClient.readEvents(roomId, guest.participantCredential, 0)).latestSeq;
            const started = Date.now();
            const waited = guestClient.waitForChange(roomId, guest.participantCredential, latest, 20_000);
            await new Promise((resolve) => setTimeout(resolve, 200));
            await message(owner, roomId, ownerCredential, guest.participantId, 'Wake up');
            await waited;
            const woke = Date.now() - started;
            if (woke > 5000) {
                fail(`the waiting read answered after ${woke} ms`);
            }
            const quiet = Date.now();
            await guestClient.waitForChange(roomId, guest.participantCredential, latest + 100, 500);
            if (Date.now() - quiet < 400) {
                fail('a read with nothing new did not wait');
            }
            await owner.delete(roomId, controllerCredential);
            return `woke after ${woke} ms`;
        }
    }
];

export async function runConformance({relay, createToken, only}: ConformanceOptions): Promise<ConformanceReport> {
    const base = relay.replace(/\/+$/, '');
    const description = await new PairLobbyClient(base).describe();
    const context: CheckContext = {relay: base, description, owner: () => new PairLobbyClient(base, createToken), stranger: () => new PairLobbyClient(base)};
    const results: CheckResult[] = [];
    for (const check of CHECKS.filter((each) => !only || only.includes(each.id))) {
        const started = Date.now();
        try {
            const detail = await check.run(context);
            results.push({id: check.id, title: check.title, status: 'pass', ...(detail ? {detail} : {}), ms: Date.now() - started});
        } catch (error) {
            const status = error instanceof Skip ? 'skip' : 'fail';
            results.push({id: check.id, title: check.title, status, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started});
        }
    }
    return {relay: base, description, results, passed: results.every((result) => result.status !== 'fail')};
}

/** Reports side by side as a Markdown table: one row per check, one column per relay. */
export function parityMatrix(reports: Record<string, ConformanceReport>): string {
    const names = Object.keys(reports);
    const ids = [...new Set(Object.values(reports).flatMap((report) => report.results.map((result) => result.id)))];
    const cell = (report: ConformanceReport, id: string) => {
        const result = report.results.find((each) => each.id === id);
        return result ? `${result.status}${result.status === 'pass' ? '' : `: ${result.detail ?? ''}`}` : 'not run';
    };
    return [`| check | ${names.join(' | ')} |`, `|---|${names.map(() => '---|').join('')}`, ...ids.map((id) => `| ${id} | ${names.map((name) => cell(reports[name]!, id).replace(/\|/g, '/')).join(' | ')} |`)].join('\n');
}

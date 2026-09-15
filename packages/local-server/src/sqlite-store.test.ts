//! The same contract the in-memory reference satisfies, run against SQLite.
//! Parity is the point: a behaviour that differs here is a bug in this adapter,
//! not a property of local mode.

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {runRedemptionContract, runRoomContract} from '@pairlobby/fixtures';
import {afterAll} from 'vitest';

import {SqliteRoomStore} from './sqlite-store.js';

const directory = mkdtempSync(join(tmpdir(), 'pairlobby-sqlite-'));
let counter = 0;

function makeStore() {
    counter += 1;
    return new SqliteRoomStore(join(directory, `room-${counter}.sqlite`));
}

afterAll(() => rmSync(directory, {recursive: true, force: true}));

runRoomContract('room contract / sqlite store', makeStore);
runRedemptionContract('invite redemption recovery / sqlite store', makeStore);

// The old room transcript is not discarded when upgrading to the durable inbox.
import {test,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {RoomService} from '@pairlobby/server-core';
import {newCredential,newId} from '@pairlobby/protocol';
test('migration restores every retained unanswered request without inventing receipts',async()=>{
    const path=join(directory,'legacy-requests.sqlite');
    let store=new SqliteRoomStore(path);const service=new RoomService(store);
    const alice=newCredential('participant'),bob=newCredential('participant');
    const room=await service.createRoom({name:'legacy',displayName:'alice',kind:'agent',participantCredential:alice,controllerCredential:newCredential('controller')});
    const joined=await service.redeemInvite({code:room.invite.code,displayName:'bob',kind:'agent',participantCredential:bob,attemptId:newId('attempt')});
    for(const text of ['first','second','third']) await service.send(room.roomId,alice,{type:'message',recipientId:joined.participantId,payload:{text,priority:'normal'},idempotencyKey:newId('event')});
    store.close();
    const legacy=new DatabaseSync(path);
    legacy.exec("DROP TABLE message_requests; DELETE FROM meta WHERE key='message_requests_v1'");legacy.close();
    store=new SqliteRoomStore(path);
    try {
        const pending=await store.messageRequests(room.roomId,0,100);
        expect(pending.requests.map(r=>r.text)).toEqual(['first','second','third']);
        expect(pending.requests.every(r=>r.receivedAt===null && r.responseEventId===null)).toBe(true);
    } finally {store.close();}
});

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

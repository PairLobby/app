import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,test} from 'vitest';
import {createTestHarness} from 'wrangler';
import {runRoomContract,runRedemptionContract} from '@pairlobby/fixtures';
import type {TestableRoomStore} from '@pairlobby/fixtures';
import type {StoreFixture} from '../test/store-worker';
import type {HostedRoomStore} from './store';

const harness=createTestHarness({workers:[{configPath:'packages/hosted/test/wrangler.jsonc'}]});
let namespace: DurableObjectNamespace<StoreFixture>;
beforeAll(async()=>{
    await harness.listen();
    namespace=(await harness.getWorker<{STORES:DurableObjectNamespace<StoreFixture>}>().getEnv()).STORES;
},60_000);
afterAll(async()=>{await harness.close();});
function factory(): TestableRoomStore {
    const stub=namespace.getByName(randomUUID());
    let pending: Promise<unknown> = Promise.resolve();
    // The fixture contract exposes synchronous retention injection. Queue that
    // injection and await it before the next RPC so the simulation is ordered.
    return new Proxy({} as TestableRoomStore,{
        get(_target,method: keyof TestableRoomStore) {
            if(method==='close') return ()=>{};
            if(method==='dropHistoryBefore') return (...args:unknown[])=>{pending=stub.call(method,args);};
            return async (...args:unknown[])=>{await pending;return stub.call(method as keyof HostedRoomStore,args);};
        },
    });
}
runRoomContract('room contract / Durable Object SQLite',factory);
runRedemptionContract('invite recovery / Durable Object SQLite',factory);

test('SQLite storage size falls after retained data is removed',async()=>{
    const sizes=await namespace.getByName(randomUUID()).storageProbe();
    expect(sizes.filled).toBeGreaterThan(sizes.before);
    expect(sizes.after).toBeLessThan(sizes.filled);
},10_000);

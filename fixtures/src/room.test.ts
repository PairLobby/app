import {runRoomContract} from './contract.js';
import {MemoryStore} from './memory-store.js';
import {runRedemptionContract} from './redemption-contract.js';

runRoomContract('room contract / in-memory store', () => new MemoryStore());
runRedemptionContract('invite redemption recovery / in-memory store', () => new MemoryStore());

import {runRoomContract} from '../src/contract.js';
import {runFileContract} from '../src/file-contract.js';
import {MemoryStore} from '../src/memory-store.js';
import {runRedemptionContract} from '../src/redemption-contract.js';

runRoomContract('room contract / in-memory store', () => new MemoryStore());
runRedemptionContract('invite redemption recovery / in-memory store', () => new MemoryStore());
runFileContract('file store / in-memory store', () => new MemoryStore());

// Test-only RPC bridge: runs the shared adapter contract against real DO SQLite.
import {DurableObject} from 'cloudflare:workers';
import {HostedRoomStore} from '../src/store';
import {ProtocolError} from '@pairlobby/protocol';

export type StoreCallResult = {ok: true; value: string} | {ok: false; error: {code: string; message: string}};
export class StoreFixture extends DurableObject {
    private readonly store = new HostedRoomStore(this.ctx.storage);
    async storageProbe() {
        const sql = this.ctx.storage.sql;
        const before = sql.databaseSize;
        sql.exec('CREATE TABLE probe(value BLOB)');
        sql.exec('INSERT INTO probe VALUES(zeroblob(1000000))');
        const filled = sql.databaseSize;
        sql.exec('DROP TABLE probe');
        return {before, filled, after: sql.databaseSize};
    }
    async call(method: keyof HostedRoomStore, args: unknown[]): Promise<StoreCallResult> {
        try {
            return {ok: true, value: JSON.stringify(await Reflect.apply(this.store[method], this.store, args) ?? null)};
        } catch (error) {
            return {ok: false, error: {code: error instanceof ProtocolError ? error.code : 'server_unavailable', message: error instanceof Error ? error.message : 'Store operation failed'}};
        }
    }
}
export default {
    fetch() {
        return new Response('test fixture');
    }
};

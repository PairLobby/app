import type {Mutation} from '@pairlobby/room-core';
import type {FileRecord} from '@pairlobby/protocol';
import type {CommittedChange} from '@pairlobby/server-core';

export type SqlValue = string | number | bigint | null | Uint8Array | ArrayBuffer;
export type SqlRow = Record<string, unknown>;
export type SqlResult = {changes: number | bigint};
export type SqlTransaction = <T>(action: () => T) => T;

export interface SqlStatement {
    run(...values: SqlValue[]): SqlResult;
    get(...values: SqlValue[]): SqlRow | undefined;
    all(...values: SqlValue[]): SqlRow[];
    iterate(...values: SqlValue[]): Iterable<SqlRow>;
}

export interface SqlDatabase {
    exec(query: string): void;
    prepare(query: string): SqlStatement;
}

export type SqliteStoreOptions = {
    /** Synchronous quota/account changes in the same SQL transaction; must not perform external effects. */
    beforeApply?: (mutation: Mutation) => void;
    /** Plan-level file quota and retention decisions, in the same transaction as the staged quota reservation. */
    beforeFileReservation?: (file: FileRecord) => void;
    /** A delivery hint after the transaction succeeds; the durable transcript and revision remain authoritative. */
    afterCommit?: (change: CommittedChange) => void;
};

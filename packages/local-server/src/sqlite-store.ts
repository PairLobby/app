import * as sqlite from 'node:sqlite';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '@pairlobby/sqlite';
import type {SqlDatabase, SqlValue, SqliteStoreOptions} from '@pairlobby/sqlite';

function bind(value: SqlValue): sqlite.SQLInputValue {
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function driver(database: DatabaseSync): SqlDatabase {
    return {
        exec: (query) => database.exec(query),
        prepare(query) {
            const statement = database.prepare(query);
            return {
                run: (...values) => statement.run(...values.map(bind)),
                get: (...values) => statement.get(...values.map(bind)),
                all: (...values) => statement.all(...values.map(bind)),
                iterate: (...values) => statement.iterate(...values.map(bind))
            };
        }
    };
}

/** The Node adapter owns its connection, transaction lifetime and online backup. SQL behavior is shared with Durable Objects. */
export class SqliteRoomStore extends SqliteStore {
    private readonly database: DatabaseSync;

    constructor(location: string, options: SqliteStoreOptions = {}) {
        const database = new DatabaseSync(location);
        database.exec('PRAGMA journal_mode = WAL');
        database.exec('PRAGMA foreign_keys = ON');
        database.exec('PRAGMA busy_timeout = 5000');
        super(driver(database), (action) => {
            database.exec('BEGIN IMMEDIATE');
            try {
                const result = action();
                database.exec('COMMIT');
                return result;
            } catch (error) {
                database.exec('ROLLBACK');
                throw error;
            }
        }, options);
        this.database = database;
    }

    close(): void {
        this.database.close();
    }

    changeCount(): number {
        return Number(this.database.prepare('SELECT total_changes() AS changes').get()!['changes']);
    }

    async snapshot(destination: string): Promise<void> {
        if (typeof sqlite.backup === 'function') {
            await sqlite.backup(this.database, destination, {rate: 100});
            return;
        }
        this.database.prepare('VACUUM INTO ?').run(destination);
    }
}

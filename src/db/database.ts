// Thin access layer over node:sqlite (DESIGN 2). Kept small so it can be swapped for better-sqlite3 if needed.

import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

export type Db = DatabaseSync;

/** Opens (and if new, creates) the database. Use ':memory:' for tests. */
export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5_000 });
  // WAL applies to file databases; an in-memory database stays in 'memory' mode.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version === SCHEMA_VERSION) return;
  if (row.user_version !== 0) {
    throw new Error(`database schema version ${row.user_version} is not supported (expected ${SCHEMA_VERSION})`);
  }
  immediate(db, () => {
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/**
 * Runs fn inside BEGIN IMMEDIATE (DESIGN 4.1): commits if it returns, rolls everything back if it throws.
 * fn must be synchronous: no transaction may stay open across an await (external calls happen outside).
 */
export function immediate<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) throw new Error('immediate() does not nest: a transaction is already open');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      throw new TypeError('immediate() callback must be synchronous');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** Error codes raised by the schema's triggers. */
export type SchemaRaise =
  | 'SLOT_CONFLICT'
  | 'MODE_IMMUTABLE'
  | 'OBLIGATION_MUST_START_OPEN'
  | 'OBLIGATION_IMMUTABLE'
  | 'OBLIGATION_SETTLED'
  | 'SETTLEMENT_MISMATCH'
  | 'DELIVERY_NOT_VERIFIED'
  | 'ATTEMPT_STATUS_REGRESSION'
  | 'OPERATION_STATUS_REGRESSION'
  | 'RECONCILE_REGRESSION'
  | 'OPERATION_IMMUTABLE';

export function isSchemaRaise(error: unknown, code: SchemaRaise): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'ERR_SQLITE_ERROR' && error.message === code;
}

export function isSlotConflict(error: unknown): boolean {
  return isSchemaRaise(error, 'SLOT_CONFLICT');
}

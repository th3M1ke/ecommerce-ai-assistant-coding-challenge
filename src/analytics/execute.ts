/**
 * Running a validated statement against the database, without being able to
 * change it and without being able to run away with it.
 *
 * Three independent guards: the connection is opened read-only, `query_only` is
 * set on it, and the statement has already been proved read-only by `sql.ts`.
 * Any one of them would do; together, a write cannot be reached even if some
 * future code path opens the file differently.
 *
 * Rows are pulled one at a time and the pull stops one past the cap, so a
 * statement that would return the whole cross product of four tables costs a
 * hundred rows rather than the whole product.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { openDatabase } from '../database/connection.ts';
import { MAX_ROWS } from './query.ts';

export type Row = Record<string, string | number | null>;

export interface ExecutionResult {
  rows: Row[];
  /** True when rows existed beyond the cap. */
  hasMore: boolean;
  durationMs: number;
}

/**
 * Lowercased with diacritics removed, so a question written in plain ASCII can
 * still find `Sofía Ramírez`, `Zoë Whitfield` or `Lucas Müller`. SQLite's own
 * `LIKE` and `LOWER()` fold ASCII only, which is why this exists at all.
 */
export function unaccent(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function openAnalyticsDatabase(path?: string): DatabaseType {
  const db = openDatabase({ path, readonly: true });
  db.pragma('query_only = ON');

  // Registered on the connection rather than the file, so it costs nothing and
  // changes nothing about the database itself.
  db.function('unaccent', { deterministic: true }, (value) =>
    typeof value === 'string' ? unaccent(value) : value === null ? null : String(value),
  );

  return db;
}

export interface ExecuteOptions {
  /** Rows to return at most. One more is read, to report that more exist. */
  maxRows?: number;
}

export function executeSelect(
  db: DatabaseType,
  sql: string,
  { maxRows = MAX_ROWS }: ExecuteOptions = {},
): ExecutionResult {
  const startedAt = performance.now();

  const rows: Row[] = [];
  let hasMore = false;

  const iterator = db.prepare(sql).iterate() as IterableIterator<Row>;
  try {
    for (const row of iterator) {
      if (rows.length === maxRows) {
        hasMore = true;
        break;
      }
      rows.push(row);
    }
  } finally {
    // Breaking out of the loop leaves the statement mid-flight; SQLite needs
    // telling, or the statement stays busy for the life of the connection.
    iterator.return?.();
  }

  return { rows, hasMore, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 };
}
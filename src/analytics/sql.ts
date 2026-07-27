/**
 * Deciding whether a statement the model wrote is safe to run.
 *
 * The model writes SQL, so the question is no longer "can a string from the
 * model reach a statement" but "what can that statement do". The answer is
 * fixed here, and every layer is cheap enough to run on every request:
 *
 *   1. one statement, no comments, no bind placeholders
 *   2. it starts with SELECT or WITH, and mentions no writing keyword
 *   3. SQLite itself can prepare it
 *   4. SQLite reports the prepared statement as read-only and row-returning
 *   5. the columns it produces are the ones the model said it would produce
 *
 * Steps 1 and 2 are text checks and could in principle be fooled; steps 3 and 4
 * are SQLite's own opinion of the parsed statement and cannot be. The read-only
 * connection in `execute.ts` sits underneath all of it, so a write has to get
 * past the parser, the driver and the file handle.
 *
 * A rejection is a message, not an exception: it goes back to the model as the
 * repair round-trip, in the same way a schema violation does.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { headlinePlaceholders, type SqlQuery } from './query.ts';

export type SqlCheck = { ok: true; sql: string; columns: string[] } | { ok: false; error: string };

/**
 * Statements that change something, plus the ones that reach outside the
 * current query: ATTACH would open another file, PRAGMA can alter connection
 * behaviour. `REPLACE` is only matched as `REPLACE INTO`, because `replace()`
 * is an ordinary string function worth keeping.
 */
const FORBIDDEN = [
  /\b(insert|update|delete|drop|create|alter|attach|detach|pragma|vacuum|reindex)\b/i,
  /\breplace\s+into\b/i,
  /\b(begin|commit|end\s+transaction|rollback|savepoint|release)\b/i,
  /\b(sqlite_|pragma_)\w*/i,
];

/**
 * Quoted text is removed before the text checks so that a semicolon, a comment
 * marker or the word "delete" inside a string literal is not mistaken for the
 * real thing. The result is only used for matching, never executed.
 */
function stripQuoted(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\[[^\]]*\]/g, '[]')
    .replace(/`(?:[^`]|``)*`/g, '``');
}

function reject(error: string): SqlCheck {
  return { ok: false, error };
}

/** Everything except the model's own claims about the columns. */
export function checkSelectOnly(db: DatabaseType, rawSql: string): SqlCheck {
  const sql = rawSql.trim().replace(/[\s;]+$/, '');
  if (sql.length === 0) return reject('the statement is empty');

  const bare = stripQuoted(sql);

  if (bare.includes('--') || bare.includes('/*')) {
    return reject('SQL comments are not allowed; send the statement without them');
  }

  if (bare.includes(';')) {
    return reject('only one statement is allowed, and it must not contain a semicolon');
  }

  if (/\?|[:@$][A-Za-z_]/.test(bare)) {
    return reject(
      'bind parameters are not supported; write the values into the statement as literals',
    );
  }

  if (!/^(select|with)\b/i.test(bare)) {
    return reject('the statement must start with SELECT or WITH');
  }

  for (const pattern of FORBIDDEN) {
    const match = pattern.exec(bare);
    if (match) {
      return reject(`"${match[0]}" is not allowed; only reading the four tables is permitted`);
    }
  }

  let statement;
  try {
    statement = db.prepare(sql);
  } catch (error) {
    return reject(`SQLite rejected the statement: ${error instanceof Error ? error.message : String(error)}`);
  }

  // SQLite's own verdict on the parsed statement, which no amount of creative
  // formatting can talk it out of.
  if (!statement.readonly) {
    return reject('the statement would modify the database');
  }
  if (!statement.reader) {
    return reject('the statement does not return rows');
  }

  return { ok: true, sql, columns: statement.columns().map((column) => column.name) };
}

/**
 * The same checks, plus the model's declared columns against the ones the
 * statement actually produces. A mismatch means the answer would be labelled
 * with headings that belong to a different query, so it is worth a round-trip.
 */
export function checkQuery(db: DatabaseType, query: SqlQuery): SqlCheck {
  const checked = checkSelectOnly(db, query.sql);
  if (!checked.ok) return checked;

  const produced = new Set(checked.columns);
  const declared = new Set(query.columns.map((column) => column.key));

  const missing = [...declared].filter((key) => !produced.has(key));
  if (missing.length > 0) {
    return reject(
      `the statement does not return the declared column${missing.length > 1 ? 's' : ''} ${missing
        .map((key) => `"${key}"`)
        .join(', ')}; it returns ${checked.columns.map((name) => `"${name}"`).join(', ')}`,
    );
  }

  const undeclared = checked.columns.filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    return reject(
      `the statement returns ${undeclared
        .map((name) => `"${name}"`)
        .join(', ')}, which ${undeclared.length > 1 ? 'are' : 'is'} not declared in "columns"; every selected expression needs an alias and an entry there`,
    );
  }

  // Redundant with the schema, which checks the same thing, but it costs
  // nothing and keeps the guarantee next to the code that relies on it.
  if (query.headline) {
    const unknown = headlinePlaceholders(query.headline).filter((key) => !declared.has(key));
    if (unknown.length > 0) {
      return reject(`the headline refers to undeclared columns: ${unknown.join(', ')}`);
    }
  }

  return checked;
}

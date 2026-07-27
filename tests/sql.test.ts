/**
 * The guard that decides whether a statement the model wrote may run.
 *
 * Everything here runs against the real read-only connection, so the checks are
 * tested against SQLite's own opinion of each statement rather than against a
 * parser written for the test.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { checkQuery, checkSelectOnly } from '../src/analytics/sql.ts';
import { executeSelect, unaccent } from '../src/analytics/execute.ts';
import { sqlQuerySchema } from '../src/analytics/query.ts';
import { loadSeedData, openSeededDatabase } from './helpers.ts';

const db = openSeededDatabase();
afterAll(() => db.close());

function check(sql: string) {
  return checkSelectOnly(db, sql);
}

function errorFor(sql: string): string {
  const result = check(sql);
  if (result.ok) throw new Error(`expected "${sql}" to be rejected`);
  return result.error;
}

describe('statements that are allowed', () => {
  it('accepts a plain aggregate', () => {
    const result = check('SELECT COUNT(*) AS order_count FROM orders LIMIT 1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns).toEqual(['order_count']);
  });

  it('accepts a common table expression', () => {
    const result = check(
      `WITH totals AS (
         SELECT order_id, SUM(quantity * unit_price_cents) AS total_cents FROM order_items GROUP BY order_id
       )
       SELECT MAX(total_cents) AS max_order_value_cents FROM totals LIMIT 1`,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a trailing semicolon by trimming it, and reports the trimmed statement', () => {
    const result = check('SELECT COUNT(*) AS order_count FROM orders LIMIT 1;  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toBe('SELECT COUNT(*) AS order_count FROM orders LIMIT 1');
  });

  it('accepts a semicolon inside a string literal', () => {
    const result = check("SELECT COUNT(*) AS matches FROM users WHERE name LIKE '%;%' LIMIT 1");
    expect(result.ok).toBe(true);
  });

  it('accepts the word delete inside a string literal', () => {
    const result = check("SELECT COUNT(*) AS matches FROM products WHERE name LIKE '%delete%' LIMIT 1");
    expect(result.ok).toBe(true);
  });
});

describe('statements that are refused', () => {
  it('refuses every kind of write', () => {
    const writes = [
      "INSERT INTO users (name, email, created_at) VALUES ('x', 'x', 'x')",
      'UPDATE users SET name = 1',
      'DELETE FROM orders',
      'DROP TABLE orders',
      'CREATE TABLE t (a INTEGER)',
      'ALTER TABLE users RENAME TO people',
      "REPLACE INTO users (id, name, email, created_at) VALUES (1, 'x', 'x', 'x')",
    ];

    for (const sql of writes) {
      expect(check(sql).ok, sql).toBe(false);
    }
  });

  it('refuses PRAGMA and ATTACH, which reach outside the query', () => {
    expect(check('PRAGMA query_only = OFF').ok).toBe(false);
    expect(check("ATTACH DATABASE '/tmp/evil.sqlite' AS evil").ok).toBe(false);
    // The table-valued forms start with SELECT, so they need the keyword check.
    expect(errorFor("SELECT name AS column_name FROM pragma_table_info('users') LIMIT 5")).toMatch(
      /not allowed/i,
    );
  });

  it('refuses a write dressed up as a WITH statement', () => {
    expect(errorFor('WITH doomed AS (SELECT id FROM orders) DELETE FROM orders')).toMatch(
      /not allowed/i,
    );
  });

  it('refuses a second statement smuggled in behind the first', () => {
    expect(errorFor('SELECT 1 AS one; DELETE FROM orders')).toMatch(/only one statement/i);
  });

  it('refuses comments, which can hide the rest of a line', () => {
    expect(errorFor('SELECT COUNT(*) AS n FROM orders -- and then some')).toMatch(/comments/i);
    expect(errorFor('SELECT /* sneaky */ COUNT(*) AS n FROM orders')).toMatch(/comments/i);
  });

  it('refuses bind parameters, because nothing is bound', () => {
    expect(errorFor('SELECT COUNT(*) AS n FROM orders WHERE id = ?')).toMatch(/bind parameters/i);
    expect(errorFor('SELECT COUNT(*) AS n FROM orders WHERE id = :id')).toMatch(/bind parameters/i);
  });

  it('refuses anything that does not begin with SELECT or WITH', () => {
    expect(errorFor('EXPLAIN SELECT 1 AS one')).toMatch(/must start with SELECT or WITH/i);
    expect(errorFor('VALUES (1)')).toMatch(/must start with SELECT or WITH/i);
  });

  it('refuses a peek at the schema tables', () => {
    expect(errorFor('SELECT name AS table_name FROM sqlite_master LIMIT 5')).toMatch(/not allowed/i);
  });

  it('turns a SQLite error into a message rather than an exception', () => {
    expect(errorFor('SELECT profit_cents AS profit FROM orders LIMIT 1')).toMatch(
      /SQLite rejected the statement.*profit_cents/is,
    );
    expect(errorFor('SELECT FROM WHERE')).toMatch(/SQLite rejected the statement/i);
  });

  it('refuses an empty statement', () => {
    expect(errorFor('   ;  ')).toMatch(/empty/i);
  });
});

describe('the declared columns', () => {
  const columns = [{ key: 'order_count', label: 'Orders', kind: 'count' as const }];

  it('accepts a statement whose output matches what was declared', () => {
    const query = sqlQuerySchema.parse({
      title: 'Orders',
      sql: 'SELECT COUNT(*) AS order_count FROM orders LIMIT 1',
      columns,
    });
    expect(checkQuery(db, query).ok).toBe(true);
  });

  it('refuses a declared column the statement does not return', () => {
    const query = sqlQuerySchema.parse({
      title: 'Orders',
      sql: 'SELECT COUNT(*) AS total FROM orders LIMIT 1',
      columns,
    });
    const result = checkQuery(db, query);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"order_count"');
    expect(result.error).toContain('"total"');
  });

  it('refuses a returned column that was never declared, which would be unlabelled', () => {
    const query = sqlQuerySchema.parse({
      title: 'Orders',
      sql: 'SELECT COUNT(*) AS order_count, MIN(ordered_at) AS first_order FROM orders LIMIT 1',
      columns,
    });
    const result = checkQuery(db, query);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"first_order"');
  });

  it('refuses an unaliased expression, since it has no key to be declared under', () => {
    const query = sqlQuerySchema.parse({
      title: 'Orders',
      sql: 'SELECT COUNT(*) FROM orders LIMIT 1',
      columns,
    });
    expect(checkQuery(db, query).ok).toBe(false);
  });

  it('rejects a headline placeholder that names no column, at the schema', () => {
    const parsed = sqlQuerySchema.safeParse({
      title: 'Orders',
      sql: 'SELECT COUNT(*) AS order_count FROM orders LIMIT 1',
      columns,
      headline: '{order_count} orders worth {order_value_cents}.',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the row cap', () => {
  it('stops reading one row past the cap and says there are more', () => {
    const result = executeSelect(db, 'SELECT id AS line_id FROM order_items', { maxRows: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.hasMore).toBe(true);
  });

  it('reports no more rows when the result fits', () => {
    const result = executeSelect(db, 'SELECT COUNT(*) AS n FROM orders', { maxRows: 5 });
    expect(result.rows).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });

  it('leaves the connection usable after a capped read', () => {
    executeSelect(db, 'SELECT id AS line_id FROM order_items', { maxRows: 1 });
    const after = executeSelect(db, 'SELECT COUNT(*) AS n FROM orders');
    expect(after.rows[0].n).toBe(loadSeedData().orders.length);
  });
});

describe('unaccent', () => {
  it('folds diacritics and case, in JavaScript and in SQL alike', () => {
    expect(unaccent('Sofía Ramírez')).toBe('sofia ramirez');

    const rows = executeSelect(
      db,
      "SELECT name AS user_name FROM users WHERE unaccent(name) LIKE unaccent('%SOFIA RAMIREZ%') LIMIT 5",
    ).rows;
    expect(rows.map((row) => row.user_name)).toEqual(['Sofía Ramírez']);
  });

  it('is what plain LIKE cannot do', () => {
    const rows = executeSelect(
      db,
      "SELECT name AS user_name FROM users WHERE LOWER(name) LIKE '%sofia ramirez%' LIMIT 5",
    ).rows;
    expect(rows).toHaveLength(0);
  });
});

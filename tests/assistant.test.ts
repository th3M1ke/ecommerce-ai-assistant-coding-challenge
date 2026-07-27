/**
 * The whole path, end to end: a stubbed model, the real guard, the real seeded
 * database.
 *
 * Every expected figure is computed from the seed JSON in plain JavaScript, so a
 * mistake in the SQL cannot quietly agree with a mistake in the expectation.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { Assistant } from '../src/assistant.ts';
import { conversationContextSchema } from '../src/ai/context.ts';
import { InterpretationError } from '../src/ai/interpret.ts';
import { MAX_ROWS } from '../src/analytics/query.ts';
import {
  FIXED_NOW,
  loadSeedData,
  openSeededDatabase,
  rawStubProvider,
  reactiveStubProvider,
  stubProviderFor,
  sumValue,
  type Seed,
} from './helpers.ts';

const db = openSeededDatabase();
const seed = loadSeedData();
afterAll(() => db.close());

/** The join every question over line items needs, written once. */
const LINES = `FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN users u ON u.id = o.user_id
JOIN products p ON p.id = oi.product_id`;

function ask(question: string, interpretation: unknown, options: { now?: Date } = {}) {
  const assistant = new Assistant(db, stubProviderFor(interpretation));
  return assistant.ask({ question, now: options.now ?? FIXED_NOW });
}

function within(lines: Seed['lines'], from: string, to: string): Seed['lines'] {
  return lines.filter((line) => line.ordered_at >= from && line.ordered_at < to);
}

function rank<T extends string | number>(
  lines: Seed['lines'],
  key: (line: Seed['lines'][number]) => T,
  value: (line: Seed['lines'][number]) => number,
): { key: T; total: number }[] {
  const totals = new Map<T, number>();
  for (const line of lines) {
    totals.set(key(line), (totals.get(key(line)) ?? 0) + value(line));
  }
  return [...totals.entries()]
    .map(([entryKey, total]) => ({ key: entryKey, total }))
    .sort((a, b) => b.total - a.total);
}

describe('answering the example questions', () => {
  it('ranks the top five users by order value over the last seven days', async () => {
    const response = await ask(
      'Who ordered the most in the last seven days? Return the top five users and their total order values.',
      {
        kind: 'query',
        queries: [
          {
            title: 'Top users by order value, last 7 days',
            sql: `SELECT u.id AS user_id, u.name AS user_name,
                    SUM(oi.quantity * oi.unit_price_cents) AS order_value_cents,
                    COUNT(DISTINCT o.id) AS order_count
                  ${LINES}
                  WHERE o.ordered_at >= '2026-07-15T00:00:00.000Z' AND o.ordered_at < '2026-07-22T00:00:00.000Z'
                  GROUP BY u.id, u.name
                  ORDER BY order_value_cents DESC
                  LIMIT 5`,
            columns: [
              { key: 'user_id', label: 'User id', kind: 'id' },
              { key: 'user_name', label: 'User', kind: 'text' },
              { key: 'order_value_cents', label: 'Order value', kind: 'money' },
              { key: 'order_count', label: 'Orders', kind: 'count' },
            ],
            headline: '{user_name} leads with {order_value_cents} across {order_count} orders.',
          },
        ],
      },
    );

    expect(response.kind).toBe('answer');
    if (response.kind !== 'answer') return;
    const [answer] = response.answers;

    const expected = rank(
      within(seed.lines, '2026-07-15T00:00:00.000Z', '2026-07-22T00:00:00.000Z'),
      (line) => line.user_id,
      (line) => line.value,
    ).slice(0, 5);

    expect(answer.rows.map((row) => row.user_id)).toEqual(expected.map((entry) => entry.key));
    expect(answer.rows.map((row) => row.order_value_cents)).toEqual(expected.map((entry) => entry.total));
    expect(answer.headline).toContain(formatExpected(expected[0].total));
  });

  it('ranks products by units ordered', async () => {
    const response = await ask('Which products were ordered in the greatest quantities?', {
      kind: 'query',
      queries: [
        {
          title: 'Products by units ordered',
          sql: `SELECT p.id AS product_id, p.name AS product_name, SUM(oi.quantity) AS units
                FROM order_items oi JOIN products p ON p.id = oi.product_id
                GROUP BY p.id, p.name
                ORDER BY units DESC
                LIMIT 5`,
          columns: [
            { key: 'product_id', label: 'Product id', kind: 'id' },
            { key: 'product_name', label: 'Product', kind: 'text' },
            { key: 'units', label: 'Units', kind: 'count' },
          ],
        },
      ],
    });

    if (response.kind !== 'answer') throw new Error('expected an answer');
    const expected = rank(seed.lines, (line) => line.product_id, (line) => line.quantity).slice(0, 5);

    expect(response.answers[0].rows.map((row) => row.units)).toEqual(
      expected.map((entry) => entry.total),
    );
  });

  it('totals a single day', async () => {
    const response = await ask('What was the total order value yesterday?', {
      kind: 'query',
      queries: [
        {
          title: 'Total order value yesterday',
          sql: `SELECT SUM(oi.quantity * oi.unit_price_cents) AS order_value_cents,
                  COUNT(DISTINCT o.id) AS order_count
                FROM order_items oi JOIN orders o ON o.id = oi.order_id
                WHERE o.ordered_at >= '2026-07-20T00:00:00.000Z' AND o.ordered_at < '2026-07-21T00:00:00.000Z'
                LIMIT 1`,
          columns: [
            { key: 'order_value_cents', label: 'Order value', kind: 'money' },
            { key: 'order_count', label: 'Orders', kind: 'count' },
          ],
          headline: "Yesterday's orders came to {order_value_cents} across {order_count} orders.",
        },
      ],
    });

    if (response.kind !== 'answer') throw new Error('expected an answer');
    const [answer] = response.answers;
    const expected = sumValue(
      within(seed.lines, '2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'),
    );

    expect(expected).toBeGreaterThan(0);
    expect(answer.rows[0].order_value_cents).toBe(expected);
    expect(answer.headline).toBe(
      `Yesterday's orders came to ${formatExpected(expected)} across ${
        new Set(within(seed.lines, '2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z').map((line) => line.order_id)).size
      } orders.`,
    );
  });

  it('answers the largest single order, which no fixed set of measures could express', async () => {
    const response = await ask('What is the max order value?', {
      kind: 'query',
      queries: [
        {
          title: 'Largest single order',
          sql: `SELECT MAX(order_total_cents) AS max_order_value_cents
                FROM (SELECT SUM(oi.quantity * oi.unit_price_cents) AS order_total_cents
                      FROM order_items oi GROUP BY oi.order_id)
                LIMIT 1`,
          columns: [{ key: 'max_order_value_cents', label: 'Largest order', kind: 'money' }],
          headline: 'The largest single order is worth {max_order_value_cents}.',
        },
      ],
    });

    if (response.kind !== 'answer') throw new Error('expected an answer');
    const perOrder = rank(seed.lines, (line) => line.order_id, (line) => line.value);
    const expected = perOrder[0].total;

    expect(response.answers[0].rows[0].max_order_value_cents).toBe(expected);
    expect(response.answers[0].headline).toBe(
      `The largest single order is worth ${formatExpected(expected)}.`,
    );
  });

  it('finds a name written without its diacritics', async () => {
    const response = await ask('How much has Sofia Ramirez spent?', {
      kind: 'query',
      queries: [
        {
          title: 'Total spend by Sofia Ramirez',
          sql: `SELECT u.id AS user_id, u.name AS user_name,
                  SUM(oi.quantity * oi.unit_price_cents) AS order_value_cents
                ${LINES}
                WHERE unaccent(u.name) LIKE unaccent('%sofia ramirez%')
                GROUP BY u.id, u.name
                LIMIT 10`,
          columns: [
            { key: 'user_id', label: 'User id', kind: 'id' },
            { key: 'user_name', label: 'User', kind: 'text' },
            { key: 'order_value_cents', label: 'Spend', kind: 'money' },
          ],
          headline: '{user_name} has spent {order_value_cents}.',
        },
      ],
    });

    if (response.kind !== 'answer') throw new Error('expected an answer');
    const sofia = seed.users.find((user) => user.name === 'Sofía Ramírez');
    if (!sofia) throw new Error('the seed data no longer contains Sofía Ramírez');
    const expected = sumValue(seed.lines.filter((line) => line.user_id === sofia.id));

    expect(response.answers[0].rows).toHaveLength(1);
    expect(response.answers[0].rows[0].user_name).toBe('Sofía Ramírez');
    expect(response.answers[0].rows[0].order_value_cents).toBe(expected);
  });

  it('answers a question that depends on another as one statement', async () => {
    const response = await ask('How many people bought the most sold product?', {
      kind: 'query',
      queries: [
        {
          title: 'Customers who bought the most sold product',
          sql: `SELECT p.name AS product_name, COUNT(DISTINCT o.user_id) AS customer_count, SUM(oi.quantity) AS units
                ${LINES}
                WHERE oi.product_id = (SELECT product_id FROM order_items GROUP BY product_id ORDER BY SUM(quantity) DESC LIMIT 1)
                GROUP BY p.id, p.name
                LIMIT 1`,
          columns: [
            { key: 'product_name', label: 'Product', kind: 'text' },
            { key: 'customer_count', label: 'Customers', kind: 'count' },
            { key: 'units', label: 'Units', kind: 'count' },
          ],
          headline: '{customer_count} customers bought {product_name}, at {units} units.',
        },
      ],
      assumptions: ['Read "most sold" as units ordered.'],
    });

    if (response.kind !== 'answer') throw new Error('expected an answer');
    const [answer] = response.answers;

    const topProductId = rank(seed.lines, (line) => line.product_id, (line) => line.quantity)[0].key;
    const buyers = new Set(
      seed.lines.filter((line) => line.product_id === topProductId).map((line) => line.user_id),
    );

    expect(answer.rows[0].customer_count).toBe(buyers.size);
    expect(answer.headline).toContain(`${buyers.size} customers bought`);
    expect(response.assumptions[0]).toContain('most sold');
  });
});

describe('honesty about the result', () => {
  it('says nothing matched rather than showing a total of nothing', async () => {
    const response = await ask(
      'What was the total order value yesterday?',
      {
        kind: 'query',
        queries: [
          {
            title: 'Total order value yesterday',
            sql: `SELECT SUM(oi.quantity * oi.unit_price_cents) AS order_value_cents
                  FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE o.ordered_at >= '2026-07-26T00:00:00.000Z' AND o.ordered_at < '2026-07-27T00:00:00.000Z'
                  HAVING order_value_cents IS NOT NULL
                  LIMIT 1`,
            columns: [{ key: 'order_value_cents', label: 'Order value', kind: 'money' }],
            headline: 'Yesterday came to {order_value_cents}.',
          },
        ],
      },
      // A week after the last order in the database, as the real clock now is.
      { now: new Date('2026-07-27T12:00:00.000Z') },
    );

    if (response.kind !== 'answer') throw new Error('expected an answer');
    expect(response.answers[0].headline).toBe('No rows match this question.');
  });

  it('renders an aggregate over no rows as an em dash rather than a zero', async () => {
    const response = await ask('What was the total order value yesterday?', {
      kind: 'query',
      queries: [
        {
          title: 'Total order value yesterday',
          sql: `SELECT SUM(oi.quantity * oi.unit_price_cents) AS order_value_cents
                FROM order_items oi JOIN orders o ON o.id = oi.order_id
                WHERE o.ordered_at >= '2026-07-26T00:00:00.000Z' AND o.ordered_at < '2026-07-27T00:00:00.000Z'
                LIMIT 1`,
          columns: [{ key: 'order_value_cents', label: 'Order value', kind: 'money' }],
          headline: 'Yesterday came to {order_value_cents}.',
        },
      ],
    });

    if (response.kind !== 'answer') throw new Error('expected an answer');
    expect(response.answers[0].rows[0].order_value_cents).toBeNull();
    expect(response.answers[0].headline).toBe('Yesterday came to —.');
  });

  it('caps a result the statement did not cap itself, and says more rows exist', async () => {
    const response = await ask('List every line item.', {
      kind: 'query',
      queries: [
        {
          title: 'Line items',
          sql: 'SELECT id AS line_id, quantity AS units FROM order_items ORDER BY id ASC LIMIT 500',
          columns: [
            { key: 'line_id', label: 'Line', kind: 'id' },
            { key: 'units', label: 'Units', kind: 'count' },
          ],
        },
      ],
    });

    if (response.kind !== 'answer') throw new Error('expected an answer');
    expect(seed.orderItems.length).toBeGreaterThan(MAX_ROWS);
    expect(response.answers[0].rows).toHaveLength(MAX_ROWS);
    expect(response.answers[0].notes).toContain(`More rows exist beyond the ${MAX_ROWS} shown.`);
  });

  it('formats cents as money and never leaks a raw cent figure into the headline', async () => {
    const response = await ask('What is the total order value?', {
      kind: 'query',
      queries: [
        {
          title: 'Total order value',
          sql: 'SELECT SUM(quantity * unit_price_cents) AS order_value_cents FROM order_items LIMIT 1',
          columns: [{ key: 'order_value_cents', label: 'Order value', kind: 'money' }],
          headline: 'All orders together come to {order_value_cents}.',
        },
      ],
    });

    if (response.kind !== 'answer') throw new Error('expected an answer');
    const total = sumValue(seed.lines);
    expect(response.answers[0].rows[0].order_value_cents).toBe(total);
    expect(response.answers[0].headline).toContain(formatExpected(total));
    expect(response.answers[0].headline).not.toContain(String(total));
  });

  it('writes its own headline when the model offers none', async () => {
    const single = await ask('How many orders are there?', {
      kind: 'query',
      queries: [
        {
          title: 'Orders',
          sql: 'SELECT COUNT(*) AS order_count FROM orders LIMIT 1',
          columns: [{ key: 'order_count', label: 'Orders', kind: 'count' }],
        },
      ],
    });

    if (single.kind !== 'answer') throw new Error('expected an answer');
    expect(single.answers[0].headline).toBe(`Orders: ${seed.orders.length}.`);

    const list = await ask('List the users.', {
      kind: 'query',
      queries: [
        {
          title: 'Users',
          sql: 'SELECT name AS user_name FROM users ORDER BY name ASC LIMIT 4',
          columns: [{ key: 'user_name', label: 'User', kind: 'text' }],
        },
      ],
    });

    if (list.kind !== 'answer') throw new Error('expected an answer');
    expect(list.answers[0].headline).toBe('4 rows.');
  });
});

describe('questions the data cannot answer', () => {
  it('passes a refusal through with its reason', async () => {
    const response = await ask('List the most sold computer related items.', {
      kind: 'unsupported',
      reason: 'Products carry only a name, a SKU and a price, so there is no category to group by.',
    });

    expect(response.kind).toBe('unsupported');
    if (response.kind !== 'unsupported') return;
    expect(response.reason).toContain('no category');
  });

  it('asks which product when the question names none', async () => {
    const response = await ask('Which users ordered a specific product?', {
      kind: 'clarification',
      question: 'Which product do you mean?',
      options: ['Name it', 'Give the SKU'],
    });

    expect(response.kind).toBe('clarification');
    if (response.kind !== 'clarification') return;
    expect(response.clarification.options).toHaveLength(2);
    expect(response.context.pendingClarification?.originalQuestion).toBe(
      'Which users ordered a specific product?',
    );
  });
});

describe('questions with more than one part', () => {
  it('answers two independent questions with two results', async () => {
    const response = await ask('Who is our most active user and which product sells best?', {
      kind: 'query',
      queries: [
        {
          title: 'Most active user',
          sql: `SELECT u.name AS user_name, COUNT(DISTINCT o.id) AS order_count
                FROM orders o JOIN users u ON u.id = o.user_id
                GROUP BY u.id, u.name ORDER BY order_count DESC LIMIT 1`,
          columns: [
            { key: 'user_name', label: 'User', kind: 'text' },
            { key: 'order_count', label: 'Orders', kind: 'count' },
          ],
        },
        {
          title: 'Best selling product',
          sql: `SELECT p.name AS product_name, SUM(oi.quantity) AS units
                FROM order_items oi JOIN products p ON p.id = oi.product_id
                GROUP BY p.id, p.name ORDER BY units DESC LIMIT 1`,
          columns: [
            { key: 'product_name', label: 'Product', kind: 'text' },
            { key: 'units', label: 'Units', kind: 'count' },
          ],
        },
      ],
      assumptions: ['Read "most active" as the number of orders placed.'],
    });

    if (response.kind !== 'answer') throw new Error('expected an answer');
    expect(response.answers.map((answer) => answer.title)).toEqual([
      'Most active user',
      'Best selling product',
    ]);
    expect(response.assumptions[0]).toContain('most active');
    // Two questions, two statements: neither answer borrows the other's numbers.
    expect(response.answers[0].sql).not.toBe(response.answers[1].sql);
  });
});

describe('carrying a conversation', () => {
  it('offers the previous statement so a follow-up can build on it', async () => {
    const first = await ask('Which product sold the most?', {
      kind: 'query',
      queries: [
        {
          title: 'Best selling product',
          sql: `SELECT p.name AS product_name, SUM(oi.quantity) AS units
                FROM order_items oi JOIN products p ON p.id = oi.product_id
                GROUP BY p.id, p.name ORDER BY units DESC LIMIT 1`,
          columns: [
            { key: 'product_name', label: 'Product', kind: 'text' },
            { key: 'units', label: 'Units', kind: 'count' },
          ],
        },
      ],
    });

    if (first.kind !== 'answer') throw new Error('expected an answer');
    expect(first.context.turns[0].queries[0].title).toBe('Best selling product');

    // The second turn answers by reusing what the prompt showed it, which is
    // what proves the previous statement actually reached the model.
    let sawContext = '';
    const assistant = new Assistant(
      db,
      reactiveStubProvider((prompt) => {
        sawContext = prompt;
        const ranking = /ORDER BY units DESC LIMIT 1/.test(prompt)
          ? 'SELECT product_id FROM order_items GROUP BY product_id ORDER BY SUM(quantity) DESC LIMIT 1'
          : 'SELECT 0';
        return {
          kind: 'query',
          queries: [
            {
              title: 'People who bought it',
              sql: `SELECT COUNT(DISTINCT o.user_id) AS customer_count
                    FROM order_items oi JOIN orders o ON o.id = oi.order_id
                    WHERE oi.product_id = (${ranking})
                    LIMIT 1`,
              columns: [{ key: 'customer_count', label: 'Customers', kind: 'count' }],
            },
          ],
        };
      }),
    );

    const second = await assistant.ask({
      question: 'How many people bought it?',
      context: first.context,
      now: FIXED_NOW,
    });

    expect(sawContext).toContain('Which product sold the most?');
    expect(sawContext).toContain('ORDER BY units DESC LIMIT 1');

    if (second.kind !== 'answer') throw new Error('expected an answer');
    const topProductId = rank(seed.lines, (line) => line.product_id, (line) => line.quantity)[0].key;
    const buyers = new Set(
      seed.lines.filter((line) => line.product_id === topProductId).map((line) => line.user_id),
    );
    expect(second.answers[0].rows[0].customer_count).toBe(buyers.size);
  });

  it('never puts a figure from a previous answer into the context', async () => {
    const first = await ask('What is the total order value?', {
      kind: 'query',
      queries: [
        {
          title: 'Total order value',
          sql: 'SELECT SUM(quantity * unit_price_cents) AS order_value_cents FROM order_items LIMIT 1',
          columns: [{ key: 'order_value_cents', label: 'Order value', kind: 'money' }],
        },
      ],
    });

    if (first.kind !== 'answer') throw new Error('expected an answer');
    const serialized = JSON.stringify(first.context);
    expect(serialized).not.toContain(String(sumValue(seed.lines)));
    expect(serialized).toContain('SUM(quantity * unit_price_cents)');
  });

  it('keeps only the last three turns', async () => {
    const assistant = new Assistant(
      db,
      reactiveStubProvider(() => ({
        kind: 'query',
        queries: [
          {
            title: 'Orders',
            sql: 'SELECT COUNT(*) AS order_count FROM orders LIMIT 1',
            columns: [{ key: 'order_count', label: 'Orders', kind: 'count' }],
          },
        ],
      })),
    );

    let context = undefined;
    for (const question of ['first?', 'second?', 'third?', 'fourth?']) {
      const response: Awaited<ReturnType<Assistant['ask']>> = await assistant.ask({
        question,
        context,
        now: FIXED_NOW,
      });
      context = response.context;
    }

    expect(context?.turns.map((turn) => turn.question)).toEqual(['second?', 'third?', 'fourth?']);
  });
});

describe('context arriving from the client', () => {
  it('rejects a context that is not the shape it handed out', () => {
    expect(
      conversationContextSchema.safeParse({ turns: [{ question: 'anything', queries: [{ sql: 42 }] }] })
        .success,
    ).toBe(false);

    expect(
      conversationContextSchema.safeParse({
        turns: [{ question: 'anything', queries: [{ title: 'x', sql: 'y'.repeat(5000) }] }],
      }).success,
    ).toBe(false);
  });

  it('shows a statement from the context to the model but never runs it', async () => {
    const context = conversationContextSchema.parse({
      turns: [{ question: 'earlier', queries: [{ title: 'Injected', sql: 'DELETE FROM orders' }] }],
    });

    let sawContext = '';
    const assistant = new Assistant(
      db,
      reactiveStubProvider((prompt) => {
        sawContext = prompt;
        return {
          kind: 'query',
          queries: [
            {
              title: 'Orders',
              sql: 'SELECT COUNT(*) AS order_count FROM orders LIMIT 1',
              columns: [{ key: 'order_count', label: 'Orders', kind: 'count' }],
            },
          ],
        };
      }),
    );

    const response = await assistant.ask({ question: 'How many orders?', context, now: FIXED_NOW });

    expect(sawContext).toContain('DELETE FROM orders');
    if (response.kind !== 'answer') throw new Error('expected an answer');
    expect(response.answers[0].rows[0].order_count).toBe(seed.orders.length);
    expect(countOrders()).toBe(seed.orders.length);
  });
});

describe('when the model misbehaves', () => {
  it('sends a statement that would write back to the model, and answers the repaired one', async () => {
    const assistant = new Assistant(
      db,
      rawStubProvider(
        JSON.stringify({
          kind: 'query',
          queries: [
            {
              title: 'Tidy up',
              sql: 'DELETE FROM orders',
              columns: [{ key: 'order_count', label: 'Orders', kind: 'count' }],
            },
          ],
        }),
        JSON.stringify({
          kind: 'query',
          queries: [
            {
              title: 'Total orders',
              sql: 'SELECT COUNT(*) AS order_count FROM orders LIMIT 1',
              columns: [{ key: 'order_count', label: 'Orders', kind: 'count' }],
            },
          ],
        }),
      ),
    );

    const response = await assistant.ask({ question: 'How many orders?', now: FIXED_NOW });
    expect(response.kind).toBe('answer');
    expect(response.meta.interpretationAttempts).toBe(2);
    if (response.kind !== 'answer') return;
    expect(response.answers[0].rows[0].order_count).toBe(seed.orders.length);
  });

  it('tells the model which columns its statement really returns', async () => {
    let repairMessage = '';
    let attempt = 0;
    const assistant = new Assistant(
      db,
      reactiveStubProvider((prompt) => {
        attempt += 1;
        if (attempt === 1) {
          return {
            kind: 'query',
            queries: [
              {
                title: 'Orders',
                sql: 'SELECT COUNT(*) AS total FROM orders LIMIT 1',
                columns: [{ key: 'order_count', label: 'Orders', kind: 'count' }],
              },
            ],
          };
        }
        repairMessage = prompt;
        return {
          kind: 'query',
          queries: [
            {
              title: 'Orders',
              sql: 'SELECT COUNT(*) AS order_count FROM orders LIMIT 1',
              columns: [{ key: 'order_count', label: 'Orders', kind: 'count' }],
            },
          ],
        };
      }),
    );

    const response = await assistant.ask({ question: 'How many orders?', now: FIXED_NOW });
    expect(response.kind).toBe('answer');
    expect(repairMessage).toContain('queries.0.sql');
    expect(repairMessage).toContain('"total"');
  });

  it('gives up rather than guessing when the second attempt is also invalid', async () => {
    const assistant = new Assistant(db, rawStubProvider('not json at all', '{"kind":"nonsense"}'));

    await expect(assistant.ask({ question: 'How many orders?', now: FIXED_NOW })).rejects.toBeInstanceOf(
      InterpretationError,
    );
  });

  it('gives up when it will not stop trying to write', async () => {
    const drop = JSON.stringify({
      kind: 'query',
      queries: [
        {
          title: 'Tidy up',
          sql: 'DROP TABLE orders',
          columns: [{ key: 'order_count', label: 'Orders', kind: 'count' }],
        },
      ],
    });
    const assistant = new Assistant(db, rawStubProvider(drop, drop));

    await expect(assistant.ask({ question: 'Remove the orders', now: FIXED_NOW })).rejects.toThrow(
      /queries\.0\.sql/,
    );
    expect(countOrders()).toBe(seed.orders.length);
  });

  it('reads JSON that arrives wrapped in fences or reasoning', async () => {
    const assistant = new Assistant(
      db,
      rawStubProvider(
        '<think>The user wants a count.</think>\n```json\n{"kind":"query","queries":[{"title":"Orders","sql":"SELECT COUNT(*) AS order_count FROM orders LIMIT 1","columns":[{"key":"order_count","label":"Orders","kind":"count"}]}]}\n```',
      ),
    );

    const response = await assistant.ask({ question: 'How many orders?', now: FIXED_NOW });
    expect(response.kind).toBe('answer');
    if (response.kind !== 'answer') return;
    expect(response.answers[0].rows[0].order_count).toBe(seed.orders.length);
  });
});

describe('the database cannot be changed', () => {
  it('refuses a write on the connection the assistant uses', () => {
    expect(() => db.prepare("INSERT INTO users (name, email, created_at) VALUES ('x','x','x')").run()).toThrow(
      /readonly|read-only/i,
    );
  });

  it('refuses a delete', () => {
    expect(() => db.prepare('DELETE FROM orders').run()).toThrow(/readonly|read-only/i);
  });
});

function countOrders(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
}

/** Mirrors the money formatting, independently of the code under test. */
function formatExpected(cents: number): string {
  return `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
}

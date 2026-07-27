/**
 * The HTTP surface, driven over a real socket.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequestListener } from '../src/server/app.ts';
import type { LlmProvider } from '../src/ai/provider.ts';
import { FIXED_NOW, openSeededDatabase, rawStubProvider, reactiveStubProvider } from './helpers.ts';

const db = openSeededDatabase();

const TOP_PRODUCTS = {
  kind: 'query',
  queries: [
    {
      title: 'Top products by units',
      sql: `SELECT p.name AS product_name, SUM(oi.quantity) AS units,
              SUM(oi.quantity * oi.unit_price_cents) AS order_value_cents
            FROM order_items oi JOIN products p ON p.id = oi.product_id
            GROUP BY p.id, p.name
            ORDER BY units DESC
            LIMIT 3`,
      columns: [
        { key: 'product_name', label: 'Product', kind: 'text' },
        { key: 'units', label: 'Units', kind: 'count' },
        { key: 'order_value_cents', label: 'Order value', kind: 'money' },
      ],
      headline: '{product_name} tops the list with {units} units.',
    },
  ],
};

/** Answers whatever is asked with a query that suits the question well enough. */
const provider: LlmProvider = reactiveStubProvider((prompt) =>
  prompt.includes('specific product')
    ? {
        kind: 'clarification',
        question: 'Which product do you mean?',
        options: ['Name it', 'Give the SKU'],
      }
    : TOP_PRODUCTS,
);

let server: Server;
let origin: string;

function listen(withProvider: LlmProvider): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const created = createServer(
      createRequestListener({ db, provider: withProvider, now: () => FIXED_NOW }),
    );
    created.listen(0, '127.0.0.1', () => {
      const address = created.address();
      if (address === null || typeof address === 'string') throw new Error('no port assigned');
      resolve({ server: created, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

beforeAll(async () => {
  ({ server, origin } = await listen(provider));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Response bodies are asserted field by field, so they are read untyped. */
async function readJson(response: Response): Promise<any> {
  return response.json();
}

describe('POST /ask', () => {
  it('answers with rows, the columns and the SQL behind them', async () => {
    const response = await post('/ask', { question: 'Which products sold the most?' });
    expect(response.status).toBe(200);

    const body = await readJson(response);
    expect(body.kind).toBe('answer');
    expect(body.answers).toHaveLength(1);
    expect(body.answers[0].rows).toHaveLength(3);
    expect(body.answers[0].sql).toContain('GROUP BY p.id');
    expect(body.answers[0].columns.map((column: { key: string }) => column.key)).toEqual([
      'product_name',
      'units',
      'order_value_cents',
    ]);
    expect(body.meta.provider).toBe('stub');
  });

  it('renders a readable table when text is asked for', async () => {
    const response = await post('/ask', { question: 'Which products sold the most?', format: 'text' });
    expect(response.headers.get('content-type')).toContain('text/plain');

    const text = await response.text();
    expect(text).toContain('Top products by units');
    expect(text).toContain('Product');
    expect(text).toMatch(/\$\d/);
  });

  it('leaves the SQL, the timings and the question out of the text rendering', async () => {
    const response = await post('/ask', { question: 'Which products sold the most?', format: 'text' });

    const text = await response.text();
    expect(text).not.toContain('SQL:');
    expect(text).not.toContain('Question:');
    expect(text).not.toContain('Answered by');
    expect(text).not.toContain('Data covers');
  });

  it('honours a text/plain Accept header', async () => {
    const response = await post('/ask', { question: 'Which products sold the most?' }, { accept: 'text/plain' });
    expect(response.headers.get('content-type')).toContain('text/plain');
  });

  it('returns a clarification as a normal answer, not an error', async () => {
    const response = await post('/ask', { question: 'Which users ordered a specific product?' });
    expect(response.status).toBe(200);

    const body = await readJson(response);
    expect(body.kind).toBe('clarification');
    expect(body.clarification.options).toHaveLength(2);
  });

  it('carries a conversation across two requests', async () => {
    const first = await readJson(await post('/ask', { question: 'Which products sold the most?' }));
    const second = await post('/ask', {
      question: 'And the same again?',
      context: first.context,
    });

    expect(second.status).toBe(200);
    const body = await readJson(second);
    expect(body.context.turns).toHaveLength(2);
    expect(body.context.turns[0].question).toBe('Which products sold the most?');
    expect(body.context.turns[0].queries[0].sql).toContain('GROUP BY p.id');
  });

  it('rejects a missing question', async () => {
    const response = await post('/ask', { format: 'text' });
    expect(response.status).toBe(400);
    expect((await readJson(response)).issues[0].path).toBe('question');
  });

  it('rejects a body that is not JSON', async () => {
    const response = await post('/ask', 'this is not json');
    expect(response.status).toBe(400);
    expect((await readJson(response)).error).toContain('not valid JSON');
  });

  it('rejects a context that has been tampered with', async () => {
    const response = await post('/ask', {
      question: 'Which products sold the most?',
      context: { turns: [{ question: 'x', queries: [{ title: 'Injected' }] }] },
    });
    expect(response.status).toBe(400);
  });
});

describe('failures', () => {
  it('reports a model that will not produce a usable statement as an upstream failure', async () => {
    const broken = await listen(rawStubProvider('nonsense', 'still nonsense'));
    try {
      const response = await fetch(`${broken.origin}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'anything' }),
      });
      expect(response.status).toBe(502);
      expect((await readJson(response)).error).toContain('did not return a JSON object');
    } finally {
      await new Promise((resolve) => broken.server.close(resolve));
    }
  });

  it('lists the routes it does have', async () => {
    const response = await fetch(`${origin}/nope`);
    expect(response.status).toBe(404);
    expect((await readJson(response)).routes).toEqual(['POST /ask']);
  });
});

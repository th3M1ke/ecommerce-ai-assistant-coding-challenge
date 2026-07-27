/**
 * Shared test fixtures.
 *
 * The seed JSON is loaded here so expectations can be computed independently of
 * the SQL under test. When a test asserts a total, that total comes from adding
 * up the fixtures in plain JavaScript, not from the query being verified.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, resolveDatabasePath } from '../src/database/connection.ts';
import { openAnalyticsDatabase } from '../src/analytics/execute.ts';
import type { Order, OrderItem, Product, User } from '../src/database/types.ts';
import { CompletionRequest, LlmProvider } from '../src/ai/provider.ts';

/** A day after the last seeded order, so relative windows have data in range. */
export const FIXED_NOW = new Date('2026-07-21T09:00:00.000Z');

/**
 * Replays canned model output, so everything downstream of interpretation can be
 * tested for real — against the seeded database, through the real SQL guard —
 * without a network call or an API key.
 */
export function createStubProvider(
  responses: string | string[] | ((request: CompletionRequest) => string),
): LlmProvider & { calls: CompletionRequest[] } {
  const queue = Array.isArray(responses) ? [...responses] : undefined;
  const calls: CompletionRequest[] = [];

  return {
    name: 'stub',
    model: 'stub',
    calls,
    async complete(request: CompletionRequest): Promise<string> {
      calls.push(request);
      if (typeof responses === 'function') return responses(request);
      if (queue) {
        const next = queue.shift();
        if (next === undefined) throw new Error('the stub provider ran out of responses');
        return next;
      }
      return responses as string;
    },
  };
}

export function openSeededDatabase() {
  const databasePath = resolveDatabasePath();
  if (!existsSync(databasePath)) {
    throw new Error(`No database at ${databasePath}. Run \`npm run db:create\` before the tests.`);
  }
  return openAnalyticsDatabase(databasePath);
}

function loadSeed<T>(file: string): T[] {
  return JSON.parse(readFileSync(path.resolve(REPO_ROOT, 'data', 'seed', file), 'utf8')) as T[];
}

export interface Seed {
  users: User[];
  products: Product[];
  orders: Order[];
  orderItems: OrderItem[];
  /** Line items with their order's timestamp and user attached. */
  lines: (OrderItem & { ordered_at: string; user_id: number; value: number })[];
}

export function loadSeedData(): Seed {
  const users = loadSeed<User>('users.json');
  const products = loadSeed<Product>('products.json');
  const orders = loadSeed<Order>('orders.json');
  const orderItems = loadSeed<OrderItem>('order-items.json');
  const ordersById = new Map(orders.map((order) => [order.id, order]));

  const lines = orderItems.map((item) => {
    const order = ordersById.get(item.order_id);
    if (!order) throw new Error(`seed order ${item.order_id} is missing`);
    return {
      ...item,
      ordered_at: order.ordered_at,
      user_id: order.user_id,
      value: item.quantity * item.unit_price_cents,
    };
  });

  return { users, products, orders, orderItems, lines };
}

export function sumValue(lines: Seed['lines']): number {
  return lines.reduce((total, line) => total + line.value, 0);
}

/**
 * A provider that replays interpretations, as though the model had produced
 * them. Input is deliberately loose: these are written the way a model writes
 * them, leaving out fields that the schema fills in with defaults.
 */
export function stubProviderFor(...interpretations: unknown[]) {
  return createStubProvider(interpretations.map((interpretation) => JSON.stringify(interpretation)));
}

/** Replays a response chosen by inspecting the prompt, for multi-turn tests. */
export function reactiveStubProvider(respond: (prompt: string) => unknown) {
  return createStubProvider((request) => JSON.stringify(respond(request.user)));
}

/** A provider that replays raw text, for testing malformed model output. */
export function rawStubProvider(...responses: string[]) {
  return createStubProvider(responses);
}

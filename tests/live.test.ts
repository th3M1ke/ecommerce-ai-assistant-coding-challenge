/**
 * The one test that talks to a real model.
 *
 * Skipped unless LIVE_LLM_TESTS=1, so the suite stays fast, free and offline by
 * default. It checks that a real model writes SQL this system will run and that
 * the numbers coming back are the right ones, which is the part a stub cannot
 * tell you.
 *
 *   LIVE_LLM_TESTS=1 npm test -- live
 */

import { afterAll, describe, expect, it } from 'vitest';
import { Assistant } from '../src/assistant.ts';
import { createProvider } from '../src/ai/create-provider.ts';
import { readProviderConfig } from '../src/ai/provider.ts';
import { loadSeedData, openSeededDatabase, sumValue } from './helpers.ts';

const enabled = process.env.LIVE_LLM_TESTS === '1';

describe.skipIf(!enabled)('a real model', () => {
  const db = openSeededDatabase();
  const seed = loadSeedData();
  const assistant = new Assistant(db, createProvider(readProviderConfig()));
  afterAll(() => db.close());

  it(
    'writes a ranking query this service will run',
    async () => {
      const response = await assistant.ask({
        question: 'Who ordered the most in the last seven days? Top five users with their totals.',
      });

      expect(response.kind).toBe('answer');
      if (response.kind !== 'answer') return;

      const [answer] = response.answers;
      expect(answer.sql).toMatch(/^(select|with)\b/i);
      expect(answer.sql).not.toMatch(/;/);
      expect(answer.rows.length).toBeLessThanOrEqual(5);
      expect(answer.columns.some((column) => column.kind === 'money' || column.kind === 'count')).toBe(
        true,
      );
    },
    120_000,
  );

  it(
    'gets the largest single order right, which needs no predefined measure',
    async () => {
      const response = await assistant.ask({ question: 'What is the largest single order worth?' });

      expect(response.kind).toBe('answer');
      if (response.kind !== 'answer') return;

      const perOrder = new Map<number, number>();
      for (const line of seed.lines) {
        perOrder.set(line.order_id, (perOrder.get(line.order_id) ?? 0) + line.value);
      }
      const expected = Math.max(...perOrder.values());

      const values = response.answers.flatMap((answer) =>
        answer.rows.flatMap((row) => Object.values(row)),
      );
      expect(values).toContain(expected);
    },
    120_000,
  );

  it(
    'gets the all-time total right',
    async () => {
      const response = await assistant.ask({ question: 'What is the total value of all orders?' });

      expect(response.kind).toBe('answer');
      if (response.kind !== 'answer') return;

      const values = response.answers.flatMap((answer) =>
        answer.rows.flatMap((row) => Object.values(row)),
      );
      expect(values).toContain(sumValue(seed.lines));
    },
    120_000,
  );

  it(
    'declines a question about categories the data does not have',
    async () => {
      const response = await assistant.ask({ question: 'List the most sold computer related items.' });
      expect(response.kind).toBe('unsupported');
    },
    120_000,
  );

  it(
    'asks which product when none is named',
    async () => {
      const response = await assistant.ask({ question: 'Which users ordered a specific product?' });
      expect(response.kind).toBe('clarification');
    },
    120_000,
  );
});

/**
 * The pipeline: question in, answer out.
 *
 * Kept apart from the HTTP layer so the whole path — interpretation, SQL
 * validation, execution, formatting — can be exercised directly in tests
 * against the seeded database.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { executeSelect } from './analytics/execute.ts';
import { renderAnswer, type RenderedAnswer } from './analytics/format.ts';
import { checkQuery } from './analytics/sql.ts';
import type { SqlQuery } from './analytics/query.ts';
import { emptyContext, nextContext, type ConversationContext, type RememberedQuery } from './ai/context.ts';
import { interpretQuestion } from './ai/interpret.ts';
import type { LlmProvider } from './ai/provider.ts';

export interface AskMeta {
  provider: string;
  model: string;
  /** 2 when the model's first response failed validation and was repaired. */
  interpretationAttempts: number;
  durationMs: number;
}

export type AskResponse =
  | {
      kind: 'answer';
      question: string;
      answers: RenderedAnswer[];
      /** Readings the model chose where the wording was loose. */
      assumptions: string[];
      /** Present when the question's other half needs this answer first. */
      suggestedFollowUp?: string;
      context: ConversationContext;
      meta: AskMeta;
    }
  | {
      kind: 'clarification';
      question: string;
      clarification: { question: string; options: string[] };
      context: ConversationContext;
      meta: AskMeta;
    }
  | {
      kind: 'unsupported';
      question: string;
      reason: string;
      context: ConversationContext;
      meta: AskMeta;
    };

export interface AskInput {
  question: string;
  context?: ConversationContext;
  /** Overridable so tests can pin relative windows to a fixed clock. */
  now?: Date;
}

export class Assistant {
  constructor(
    private readonly db: DatabaseType,
    private readonly provider: LlmProvider,
  ) {}

  async ask({ question, context = emptyContext(), now = new Date() }: AskInput): Promise<AskResponse> {
    const startedAt = performance.now();

    // The guard runs inside interpretation, so a statement that would be
    // rejected is fed back to the model rather than surfaced as a failure.
    const { interpretation, attempts } = await interpretQuestion(question, {
      provider: this.provider,
      context,
      now,
      checkSql: (query) => checkQuery(this.db, query),
    });

    const meta = (): AskMeta => ({
      provider: this.provider.name,
      model: this.provider.model,
      interpretationAttempts: attempts,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });

    if (interpretation.kind === 'unsupported') {
      return {
        kind: 'unsupported',
        question,
        reason: interpretation.reason,
        context: nextContext({ previous: context, question, queries: [] }),
        meta: meta(),
      };
    }

    if (interpretation.kind === 'clarification') {
      return {
        kind: 'clarification',
        question,
        clarification: { question: interpretation.question, options: interpretation.options },
        context: nextContext({
          previous: context,
          question,
          queries: [],
          pendingClarification: { originalQuestion: question, question: interpretation.question },
        }),
        meta: meta(),
      };
    }

    const answers: RenderedAnswer[] = [];
    const executed: RememberedQuery[] = [];

    for (const query of interpretation.queries) {
      answers.push(this.run(query));
      executed.push({ title: query.title, sql: query.sql });
    }

    return {
      kind: 'answer',
      question,
      answers,
      assumptions: interpretation.assumptions,
      ...(interpretation.suggestedFollowUp ? { suggestedFollowUp: interpretation.suggestedFollowUp } : {}),
      context: nextContext({ previous: context, question, queries: executed }),
      meta: meta(),
    };
  }

  /**
   * Only reached once `interpretQuestion` has put every statement of the
   * response through `checkQuery`, which is what makes running one here safe.
   */
  private run(query: SqlQuery): RenderedAnswer {
    const result = executeSelect(this.db, query.sql);
    return renderAnswer({ query, sql: query.sql, result });
  }
}

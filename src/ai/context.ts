/**
 * Conversation state, carried by the client rather than held by the server.
 *
 * Each response hands back a context that the next request sends along. The
 * server stores nothing, so it can be restarted or scaled out freely.
 *
 * What the context carries is a deliberate choice: previous questions and the
 * statements that answered them, never a row and never a figure. That is enough
 * for the model to inherit intent ("same thing, different month") and to
 * resolve "it" — the previous statement says which product was being ranked, so
 * the follow-up can re-derive it as a subquery — while making it impossible for
 * a stale number to be repeated. Every figure in an answer comes from a query
 * run in that request.
 *
 * Statements arriving back from the client are prompt material only. They are
 * never executed; the SQL that runs in a request is always the SQL the model
 * produced in that request, and it is validated from scratch.
 */

import { z } from 'zod';

/** Older turns add prompt noise faster than they add usefulness. */
export const MAX_REMEMBERED_TURNS = 3;

/** The part of a query worth remembering: what it was for, and how it was asked. */
const rememberedQuerySchema = z.object({
  title: z.string().min(1).max(120),
  sql: z.string().min(1).max(4000),
});

export type RememberedQuery = z.infer<typeof rememberedQuerySchema>;

/**
 * The client controls this field, so it is validated exactly like a question is:
 * bounded in size and in shape, whatever arrives.
 */
export const conversationContextSchema = z.object({
  turns: z
    .array(
      z.object({
        question: z.string().min(1).max(500),
        queries: z.array(rememberedQuerySchema).max(3).default([]),
      }),
    )
    .max(MAX_REMEMBERED_TURNS)
    .default([]),
  /** Set when the previous answer asked something back. */
  pendingClarification: z
    .object({
      /** What was asked before we interrupted with a question. */
      originalQuestion: z.string().min(1).max(500),
      /** The question we asked. */
      question: z.string().min(1).max(500),
    })
    .optional(),
});

export type ConversationContext = z.infer<typeof conversationContextSchema>;

export function emptyContext(): ConversationContext {
  return { turns: [] };
}

export function nextContext(input: {
  previous: ConversationContext;
  question: string;
  queries: RememberedQuery[];
  pendingClarification?: ConversationContext['pendingClarification'];
}): ConversationContext {
  const turns = [...input.previous.turns, { question: input.question, queries: input.queries }].slice(
    -MAX_REMEMBERED_TURNS,
  );

  return {
    turns,
    ...(input.pendingClarification ? { pendingClarification: input.pendingClarification } : {}),
  };
}

/**
 * The context as the model sees it. The statements go in verbatim, because SQL
 * is the language the model is answering in and a previous statement is the
 * most precise possible statement of what the last question meant.
 */
export function renderContext(context: ConversationContext): string {
  if (context.turns.length === 0 && !context.pendingClarification) return '';

  const parts: string[] = ['Earlier in this conversation:'];

  for (const turn of context.turns) {
    parts.push(`- question: ${turn.question}`);
    for (const query of turn.queries) {
      parts.push(`  answered with (${query.title}): ${query.sql.replace(/\s+/g, ' ')}`);
    }
  }

  if (context.turns.some((turn) => turn.queries.length > 0)) {
    parts.push(
      'When the new question says "it", "that product" or "them", it refers to what the previous statement was about. You cannot see the rows it returned, so express the reference as a subquery rather than guessing a name or an id.',
    );
  }

  if (context.pendingClarification) {
    parts.push(
      `You asked the user: "${context.pendingClarification.question}" about their earlier question: "${context.pendingClarification.originalQuestion}". Treat the new message as the answer to that question and produce the completed query.`,
    );
  }

  return parts.join('\n');
}

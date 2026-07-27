/**
 * Question in, validated interpretation out.
 *
 * This is the only place model output is trusted at all, and only as far as Zod
 * and the SQL guard allow. Both checks run before anything is executed, and a
 * response that fails either is sent back once with the reasons attached —
 * which local models in particular tend to need. A second failure is an error
 * rather than a guess.
 *
 * The guard arrives as a callback so this module keeps knowing nothing about
 * the database.
 */

import { interpretationSchema, type Interpretation, type SqlQuery } from '../analytics/query.ts';
import type { ConversationContext } from './context.ts';
import { buildRepairMessage, buildSystemPrompt, buildUserMessage } from './prompt.ts';
import type { LlmProvider } from './provider.ts';

export class InterpretationError extends Error {
  constructor(
    message: string,
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'InterpretationError';
  }
}

export interface InterpretResult {
  interpretation: Interpretation;
  /** Raw model output, kept for debugging a bad answer. */
  raw: string;
  /** 1 normally, 2 when the first response had to be repaired. */
  attempts: number;
}

/** Whatever `sql.ts` makes of one query, reduced to what this module needs. */
export type SqlChecker = (query: SqlQuery) => { ok: true } | { ok: false; error: string };

/**
 * Models wrap JSON in prose, markdown fences or reasoning tags even when asked
 * not to. Rather than fail on presentation, take the outermost JSON object.
 */
export function extractJson(text: string): unknown {
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const withoutFences = withoutThinking.replace(/```(?:json)?/gi, '');

  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new InterpretationError('the model did not return a JSON object', text);
  }

  try {
    return JSON.parse(withoutFences.slice(start, end + 1));
  } catch (error) {
    throw new InterpretationError(
      `the model returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      text,
    );
  }
}

function describeIssues(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'issues' in error) {
    const { issues } = error as { issues: { path: (string | number | symbol)[]; message: string }[] };
    return issues
      .map((issue) => `- ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

export interface InterpretOptions {
  provider: LlmProvider;
  context?: ConversationContext;
  now?: Date;
  /** Applied to every query in the response, before any of them runs. */
  checkSql: SqlChecker;
}

export async function interpretQuestion(
  question: string,
  { provider, context, now = new Date(), checkSql }: InterpretOptions,
): Promise<InterpretResult> {
  const system = buildSystemPrompt();
  const first = buildUserMessage({ question, context, now });

  const raw = await provider.complete({ system, user: first });
  const firstAttempt = validate(raw, checkSql);
  if (firstAttempt.ok) {
    return { interpretation: firstAttempt.interpretation, raw, attempts: 1 };
  }

  const repairRaw = await provider.complete({
    system,
    user: `${first}\n\n${buildRepairMessage({ question, invalid: raw, errors: firstAttempt.errors })}`,
  });
  const secondAttempt = validate(repairRaw, checkSql);
  if (secondAttempt.ok) {
    return { interpretation: secondAttempt.interpretation, raw: repairRaw, attempts: 2 };
  }

  throw new InterpretationError(
    `the model could not produce a valid query:\n${secondAttempt.errors}`,
    repairRaw,
  );
}

type ValidationOutcome =
  | { ok: true; interpretation: Interpretation }
  | { ok: false; errors: string };

function validate(raw: string, checkSql: SqlChecker): ValidationOutcome {
  let document: unknown;
  try {
    document = extractJson(raw);
  } catch (error) {
    return { ok: false, errors: error instanceof Error ? error.message : String(error) };
  }

  const parsed = interpretationSchema.safeParse(document);
  if (!parsed.success) {
    return { ok: false, errors: describeIssues(parsed.error) };
  }

  const interpretation = parsed.data;
  if (interpretation.kind !== 'query') {
    return { ok: true, interpretation };
  }

  // Every statement is checked before any of them runs, so a response is either
  // wholly usable or wholly sent back.
  const rejections = interpretation.queries
    .map((query, index) => ({ index, result: checkSql(query) }))
    .filter((checked): checked is { index: number; result: { ok: false; error: string } } => !checked.result.ok)
    .map(({ index, result }) => `- queries.${index}.sql: ${result.error}`);

  return rejections.length === 0
    ? { ok: true, interpretation }
    : { ok: false, errors: rejections.join('\n') };
}

/**
 * What the language model is allowed to return.
 *
 * The model writes the SQL, so this schema does not try to constrain what a
 * question may ask for. It constrains the envelope: one statement per result, a
 * declared shape for the columns it produces, and a headline written as a
 * template rather than as prose containing figures. Whether the statement is
 * safe to run is decided separately, in `sql.ts`, against the database itself.
 */

import { z } from 'zod';

/** How a column is rendered. `money` is whole cents; `number` allows decimals. */
export const COLUMN_KINDS = ['money', 'count', 'number', 'text', 'timestamp', 'id'] as const;

export type ColumnKind = (typeof COLUMN_KINDS)[number];

export const columnSpecSchema = z.object({
  /** The result-set alias, which must exist in the statement's output. */
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'a column key must be a plain SQL identifier'),
  label: z.string().min(1).max(60),
  kind: z.enum(COLUMN_KINDS),
});

export type ColumnSpec = z.infer<typeof columnSpecSchema>;

export const MAX_ROWS = 100;

/** `{column_key}` in a headline template, replaced with that column's value. */
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function headlinePlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

export const sqlQuerySchema = z
  .object({
    /** Short label, used as the heading when one question produces several answers. */
    title: z.string().min(1).max(120),
    sql: z.string().min(10).max(4000),
    columns: z.array(columnSpecSchema).min(1).max(12),
    /**
     * One sentence with `{column_key}` placeholders, filled from the first row.
     * The model shapes the sentence; every figure in it comes from the query.
     */
    headline: z.string().max(200).optional(),
  })
  .superRefine((query, ctx) => {
    const keys = new Set(query.columns.map((column) => column.key));

    const duplicates = query.columns.length - keys.size;
    if (duplicates > 0) {
      ctx.addIssue({ code: 'custom', path: ['columns'], message: 'column keys must be unique' });
    }

    if (!query.headline) return;
    for (const placeholder of headlinePlaceholders(query.headline)) {
      if (!keys.has(placeholder)) {
        ctx.addIssue({
          code: 'custom',
          path: ['headline'],
          message: `"{${placeholder}}" is not one of the declared columns`,
        });
      }
    }
  });

export type SqlQuery = z.infer<typeof sqlQuerySchema>;

/**
 * What the model returns for a question. Refusing is a first-class outcome, not
 * an error: a question can be answerable, under-specified, or outside the data.
 */
export const interpretationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('query'),
    /** Independent questions asked in one sentence get one query each. */
    queries: z.array(sqlQuerySchema).min(1).max(3),
    /** Readings the model chose where the wording was loose, e.g. "most active". */
    assumptions: z.array(z.string().max(300)).max(5).default([]),
    /** Offered when the question needs a result before its other half can be asked. */
    suggestedFollowUp: z.string().max(300).optional(),
  }),
  z.object({
    kind: z.literal('clarification'),
    question: z.string().min(1).max(500),
    options: z.array(z.string().max(200)).max(20).default([]),
  }),
  z.object({
    kind: z.literal('unsupported'),
    reason: z.string().min(1).max(500),
  }),
]);

export type Interpretation = z.infer<typeof interpretationSchema>;
export type QueryInterpretation = Extract<Interpretation, { kind: 'query' }>;

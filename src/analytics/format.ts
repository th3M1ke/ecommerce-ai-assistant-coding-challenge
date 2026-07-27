/**
 * Making a result readable, and showing the working.
 *
 * The model shapes the sentence but never fills it in: a headline is a template
 * of `{column_key}` placeholders, and every value substituted into it comes
 * from the row that is also printed in the table below. A sentence assembled
 * from the same values as the table cannot disagree with the table, which is
 * the point — the model chooses what to ask, and never gets to say what the
 * answer was.
 */

import type { ExecutionResult, Row } from './execute.ts';
import type { ColumnSpec, SqlQuery } from './query.ts';

/**
 * Amounts are stored in cents and calculated as integers throughout; this is the
 * only place they become decimal. The data carries no currency column, so US
 * dollars are assumed, matching the "$45.99 is 4599" convention in the brief.
 */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const units = Math.floor(absolute / 100).toLocaleString('en-US');
  const remainder = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${units}.${remainder}`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** For ratios and averages that are not money: at most two decimal places. */
function formatNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** `2026-07-20T12:00:00.000Z` reads better as `2026-07-20 12:00 UTC`. */
function formatTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]} UTC` : value;
}

export function formatValue(value: string | number | null, kind: ColumnSpec['kind']): string {
  if (value === null) return '—';
  switch (kind) {
    case 'money':
      return typeof value === 'number' ? formatCents(value) : String(value);
    case 'count':
      return typeof value === 'number' ? formatCount(value) : String(value);
    case 'number':
      return typeof value === 'number' ? formatNumber(value) : String(value);
    case 'timestamp':
      return typeof value === 'string' ? formatTimestamp(value) : String(value);
    case 'id':
      return `#${value}`;
    case 'text':
      return String(value);
  }
}

export interface RenderedAnswer {
  title: string;
  /** One sentence stating the result, assembled from the same numbers as the table. */
  headline: string;
  /** Caveats worth reading: truncation, or nothing matching at all. */
  notes: string[];
  columns: ColumnSpec[];
  /** Raw values, as SQLite returned them. */
  rows: Row[];
  rowCount: number;
  /** The exact statement that ran, so the reader can check the question was understood. */
  sql: string;
  durationMs: number;
}

export interface RenderAnswerInput {
  query: SqlQuery;
  /** The statement as validated, which may differ from the model's by trailing whitespace. */
  sql: string;
  result: ExecutionResult;
}

/**
 * The model's template with the first row's values in it. Aggregates over an
 * empty set return a row of NULLs rather than no row at all, so a placeholder
 * with nothing behind it is a real possibility and reads as an em dash.
 */
function fillTemplate(template: string, row: Row, columns: ColumnSpec[]): string {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) => {
    const column = byKey.get(key);
    if (!column) return whole;
    return formatValue(row[key] ?? null, column.kind);
  });
}

function buildHeadline({ query, result }: RenderAnswerInput): string {
  const [first] = result.rows;
  if (!first) return 'No rows match this question.';

  if (query.headline) {
    return fillTemplate(query.headline, first, query.columns);
  }

  // Without a template, a single row reads as its own label-value pairs and a
  // list is left to speak for itself.
  if (result.rows.length === 1) {
    const pairs = query.columns.map(
      (column) => `${column.label}: ${formatValue(first[column.key] ?? null, column.kind)}`,
    );
    return `${pairs.join(', ')}.`;
  }

  return `${result.rows.length} rows.`;
}

function buildNotes({ result }: RenderAnswerInput): string[] {
  const notes: string[] = [];
  if (result.hasMore) {
    notes.push(`More rows exist beyond the ${result.rows.length} shown.`);
  }
  return notes;
}

export function renderAnswer(input: RenderAnswerInput): RenderedAnswer {
  const { query, sql, result } = input;

  return {
    title: query.title,
    headline: buildHeadline(input),
    notes: buildNotes(input),
    columns: query.columns,
    rows: result.rows,
    rowCount: result.rows.length,
    sql,
    durationMs: result.durationMs,
  };
}

/** Numbers right-aligned, text left-aligned, so columns can be compared by eye. */
export function renderTable(columns: ColumnSpec[], rows: Row[]): string {
  if (rows.length === 0) return '';

  const formattedRows = rows.map((row) =>
    columns.map((column) => formatValue(row[column.key] ?? null, column.kind)),
  );
  const headers = columns.map((column) => column.label);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...formattedRows.map((row) => row[index].length)),
  );
  const alignRight = columns.map((column) => column.kind !== 'text' && column.kind !== 'timestamp');

  const pad = (value: string, index: number) =>
    alignRight[index] ? value.padStart(widths[index]) : value.padEnd(widths[index]);

  const lines = [
    headers.map((header, index) => pad(header, index)).join('  '),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...formattedRows.map((row) => row.map((cell, index) => pad(cell, index)).join('  ')),
  ];

  return lines.map((line) => line.trimEnd()).join('\n');
}

/** One answer as plain text: what it says, the numbers, and the query behind them. */
export function renderAnswerText(answer: RenderedAnswer, options: { showSql?: boolean } = {}): string {
  const parts: string[] = [answer.title, '-'.repeat(answer.title.length), answer.headline];

  const table = renderTable(answer.columns, answer.rows);
  if (table.length > 0) parts.push('', table);

  for (const note of answer.notes) parts.push(`Note: ${note}`);

  if (options.showSql !== false) {
    parts.push('', 'SQL:', answer.sql);
  }

  return parts.join('\n');
}

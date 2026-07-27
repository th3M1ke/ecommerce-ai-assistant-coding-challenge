/**
 * The HTTP surface: `POST /ask`, on Node's own http module.
 *
 * No framework, because one route does not need one. The handler is exported
 * separately from the server so tests can drive it over a real socket without a
 * process to manage.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { Assistant, type AskResponse } from '../assistant.ts';
import { conversationContextSchema } from '../ai/context.ts';
import { renderAnswerText } from '../analytics/format.ts';
import { InterpretationError } from '../ai/interpret.ts';
import { ProviderError, type LlmProvider } from '../ai/provider.ts';

/** Enough for a question and three remembered turns; far short of a payload attack. */
const MAX_BODY_BYTES = 64 * 1024;

const askRequestSchema = z.object({
  question: z.string().min(1).max(500),
  /** The `context` from the previous response, to continue a thread. */
  context: conversationContextSchema.optional(),
  format: z.enum(['json', 'text']).optional(),
});

export interface AppOptions {
  db: DatabaseType;
  provider: LlmProvider;
  /** Injectable clock, so tests can pin relative windows. */
  now?: () => Date;
}

export function createRequestListener({ db, provider, now = () => new Date() }: AppOptions): RequestListener {
  const assistant = new Assistant(db, provider);

  return (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'POST' && url.pathname === '/ask') {
      await handleAsk(request, response);
      return;
    }

    sendJson(response, 404, {
      error: `no route for ${request.method} ${url.pathname}`,
      routes: ['POST /ask'],
    });
  }

  async function handleAsk(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const parsed = askRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, {
        error: 'invalid request body',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const wantsText =
      parsed.data.format === 'text' ||
      (parsed.data.format === undefined && (request.headers.accept ?? '').includes('text/plain'));

    try {
      const answer = await assistant.ask({
        question: parsed.data.question,
        context: parsed.data.context,
        now: now(),
      });

      if (wantsText) {
        sendText(response, 200, renderResponseText(answer));
      } else {
        sendJson(response, 200, answer);
      }
    } catch (error) {
      // A model that cannot produce a statement this service will run, or a
      // provider that is down, is an upstream failure rather than a bad request.
      const upstream = error instanceof InterpretationError || error instanceof ProviderError;
      const message = error instanceof Error ? error.message : String(error);
      if (wantsText) {
        sendText(response, upstream ? 502 : 500, message);
      } else {
        sendJson(response, upstream ? 502 : 500, {
          error: message,
          ...(error instanceof InterpretationError && error.raw ? { modelOutput: error.raw } : {}),
        });
      }
    }
  }
}

/**
 * The answer as plain text, for reading in a terminal: what it says, the
 * numbers behind it, and any caveat on reading them. The SQL, the timings and
 * the conversation context are in the JSON response for anyone who wants them.
 */
export function renderResponseText(response: AskResponse): string {
  const parts: string[] = [];

  switch (response.kind) {
    case 'answer': {
      parts.push(
        response.answers.map((answer) => renderAnswerText(answer, { showSql: false })).join('\n\n'),
      );
      if (response.assumptions.length > 0) {
        parts.push('', 'Assumptions:');
        for (const assumption of response.assumptions) parts.push(`- ${assumption}`);
      }
      break;
    }
    case 'clarification': {
      parts.push(`I need one more detail: ${response.clarification.question}`);
      for (const option of response.clarification.options) parts.push(`- ${option}`);
      break;
    }
    case 'unsupported': {
      parts.push(`I cannot answer that from this data: ${response.reason}`);
      break;
    }
  }

  return parts.join('\n');
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`request body is larger than ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) {
    throw new Error('expected a JSON body such as {"question": "What is the average order value?"}');
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`the request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  const body = `${text}\n`;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

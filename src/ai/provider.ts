/**
 * The seam between this service and whichever model interprets questions.
 *
 * The interface is deliberately one method returning a string. Everything that
 * matters about correctness — the schema, validation, the repair retry — lives
 * on our side of it, so swapping a hosted model for a local one changes nothing
 * else in the system.
 */

export interface CompletionRequest {
  system: string;
  user: string;
}

export interface LlmProvider {
  /** Provider id, reported in responses so an answer can be traced. */
  readonly name: string;
  readonly model: string;
  /** Returns raw model output, expected to be a JSON document. */
  complete(request: CompletionRequest): Promise<string>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * A local model needs no key but is slower; a hosted one is the reverse. The
 * default follows whichever is configured, so a fresh checkout with no
 * environment at all still starts and explains itself.
 */
export function readProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const requested = env.LLM_PROVIDER?.trim().toLowerCase();
  const provider = requested && requested.length > 0 ? requested : env.OPENAI_API_KEY ? 'openai' : 'ollama';
  const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  switch (provider) {
    case 'openai':
      return {
        provider,
        model: env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
        baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
        apiKey: env.OPENAI_API_KEY?.trim(),
        timeoutMs,
      };
    case 'ollama':
      return {
        provider,
        model: env.OLLAMA_MODEL?.trim() || 'qwen3.6',
        baseUrl: env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434',
        timeoutMs,
      };
    default:
      throw new Error(
        `unknown LLM_PROVIDER "${provider}"; expected "openai" or "ollama"`,
      );
  }
}

/** Shared JSON POST with a timeout, used by both adapters. */
export async function postJson(
  url: string,
  body: unknown,
  options: { headers?: Record<string, string>; timeoutMs: number; provider: string },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new ProviderError(
      `could not reach ${options.provider} at ${url}: ${error instanceof Error ? error.message : String(error)}`,
      options.provider,
      error,
    );
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new ProviderError(
      `${options.provider} returned ${response.status}: ${detail}`,
      options.provider,
    );
  }

  return response.json();
}

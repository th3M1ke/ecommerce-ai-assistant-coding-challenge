/**
 * OpenAI-compatible chat completions over plain `fetch`, no SDK.
 *
 * JSON object mode rather than a strict JSON schema: the shape is already
 * enforced by Zod on our side, and the loose mode behaves the same on the
 * OpenAI-compatible endpoints that other vendors expose, which keeps this
 * adapter usable beyond OpenAI itself.
 */

import {
  ProviderError,
  postJson,
  type CompletionRequest,
  type LlmProvider,
  type ProviderConfig,
} from './provider.ts';

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

export function createOpenAiProvider(config: ProviderConfig): LlmProvider {
  if (!config.apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Set it, or use LLM_PROVIDER=ollama to run against a local model.',
    );
  }

  return {
    name: 'openai',
    model: config.model,
    async complete({ system, user }: CompletionRequest): Promise<string> {
      const payload = await postJson(
        `${config.baseUrl}/chat/completions`,
        {
          model: config.model,
          // Deterministic interpretation: the same question should produce the
          // same plan, so results are reproducible and testable.
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        { headers: { authorization: `Bearer ${config.apiKey}` }, timeoutMs: config.timeoutMs, provider: 'openai' },
      );

      const content = (payload as ChatCompletionResponse).choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new ProviderError('openai returned an empty completion', 'openai');
      }
      return content;
    },
  };
}

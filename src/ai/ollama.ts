/**
 * Local models through Ollama's chat endpoint.
 *
 * Needs no API key and sends nothing off the machine, which suits a service
 * pointed at a customer database. In exchange it is slower and less obedient
 * about output shape, which is what the repair retry in `interpret.ts` is for.
 */

import {
  ProviderError,
  postJson,
  type CompletionRequest,
  type LlmProvider,
  type ProviderConfig,
} from './provider.ts';

interface OllamaChatResponse {
  message?: { content?: string };
}

export function createOllamaProvider(config: ProviderConfig): LlmProvider {
  return {
    name: 'ollama',
    model: config.model,
    async complete({ system, user }: CompletionRequest): Promise<string> {
      const payload = await postJson(
        `${config.baseUrl}/api/chat`,
        {
          model: config.model,
          stream: false,
          format: 'json',
          // `think: false` keeps reasoning models from spending their budget
          // out loud; older Ollama builds ignore the field harmlessly.
          think: false,
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        { timeoutMs: config.timeoutMs, provider: 'ollama' },
      );

      const content = (payload as OllamaChatResponse).message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new ProviderError('ollama returned an empty completion', 'ollama');
      }
      return content;
    },
  };
}

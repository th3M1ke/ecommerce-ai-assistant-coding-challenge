/**
 * Choosing a provider from the environment, plus the stub used by the tests.
 *
 * Kept apart from `provider.ts` so the adapters can depend on the interface
 * without the interface depending back on them.
 */

import { createOllamaProvider } from './ollama.ts';
import { createOpenAiProvider } from './openai.ts';
import { readProviderConfig, type CompletionRequest, type LlmProvider, type ProviderConfig } from './provider.ts';

export function createProvider(config: ProviderConfig = readProviderConfig()): LlmProvider {
  switch (config.provider) {
    case 'openai':
      return createOpenAiProvider(config);
    case 'ollama':
      return createOllamaProvider(config);
    default:
      throw new Error(`unknown LLM provider "${config.provider}"`);
  }
}

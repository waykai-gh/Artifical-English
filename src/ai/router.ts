import type { Logger } from 'pino';
import { normalizeAnswer, UserError, type ChatInput, type VocabularyInput } from '../domain.js';
import { ProviderError } from './http.js';
import type { ChatProvider } from './providers.js';

export class AiRouter {
  private readonly cooldown = new Map<string, number>();
  constructor(private readonly providers: ChatProvider[], private readonly logger: Pick<Logger, 'warn'>, private readonly now = Date.now) {}

  async chat(input: ChatInput) {
    const result = await this.route(provider => provider.chat(input));
    return { answer: normalizeAnswer(result.value, input), provider: result.provider };
  }

  async explainVocabulary(input: VocabularyInput) {
    const result = await this.route(provider => provider.explainVocabulary(input));
    return { usage: result.value, provider: result.provider };
  }

  private async route<T>(operation: (provider: ChatProvider) => Promise<T>): Promise<{ value: T; provider: ChatProvider['name'] }> {
    for (const provider of this.providers) {
      if ((this.cooldown.get(provider.name) ?? 0) > this.now()) continue;
      try {
        return { value: await operation(provider), provider: provider.name };
      } catch (error) {
        const status = error instanceof ProviderError ? error.status : 0;
        const wait = error instanceof ProviderError && error.retryAfterMs > 0 ? error.retryAfterMs
          : [401, 402, 403, 404].includes(status) ? 10 * 60_000 : status === 429 ? 60_000 : 15_000;
        this.cooldown.set(provider.name, this.now() + wait);
        this.logger.warn({ provider: provider.name, status, cooldownMs: wait }, 'AI provider unavailable; trying fallback');
      }
    }
    throw new UserError('ИИ-сервисы сейчас недоступны или исчерпали бесплатную квоту. Попробуй немного позже.');
  }
}

import type { Logger } from 'pino';
import { normalizeAnswer, UserError, type AiAttempt, type AiFeature, type ChatInput, type VocabularyInput } from '../domain.js';
import { ProviderError } from './http.js';
import { providerUsage, type ChatProvider } from './providers.js';

export interface AiObserver {
  onAiAttempt(event: AiAttempt): Promise<void> | void;
  onAiExhausted(feature: AiFeature): Promise<void> | void;
}

export class AiRouter {
  private readonly cooldown = new Map<string, number>();
  constructor(
    private readonly providers: ChatProvider[],
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly now = Date.now,
    private readonly observer?: AiObserver,
  ) {}

  async chat(input: ChatInput) {
    const result = await this.route('chat', provider => provider.chat(input));
    return { answer: normalizeAnswer(result.value, input), provider: result.provider };
  }

  async explainVocabulary(input: VocabularyInput) {
    const result = await this.route('vocabulary', provider => provider.explainVocabulary(input));
    return { usage: result.value, provider: result.provider };
  }

  private async route<T>(feature: AiFeature, operation: (provider: ChatProvider) => Promise<T>): Promise<{ value: T; provider: ChatProvider['name'] }> {
    for (const provider of this.providers) {
      if ((this.cooldown.get(provider.name) ?? 0) > this.now()) continue;
      const startedAt = this.now();
      try {
        const value = await operation(provider);
        await this.observe({ provider: provider.name, feature, outcome: 'success', statusCode: 0,
          durationMs: Math.max(0, this.now() - startedAt), usage: providerUsage(value) });
        return { value, provider: provider.name };
      } catch (error) {
        const status = error instanceof ProviderError ? error.status : 0;
        await this.observe({ provider: provider.name, feature, outcome: 'failure', statusCode: status,
          durationMs: Math.max(0, this.now() - startedAt), usage: { inputTokens: 0, outputTokens: 0 } });
        const wait = error instanceof ProviderError && error.retryAfterMs > 0 ? error.retryAfterMs
          : [401, 402, 403, 404].includes(status) ? 10 * 60_000 : status === 429 ? 60_000 : 15_000;
        this.cooldown.set(provider.name, this.now() + wait);
        this.logger.warn({ provider: provider.name, status, cooldownMs: wait }, 'AI provider unavailable; trying fallback');
      }
    }
    try { await this.observer?.onAiExhausted(feature); } catch { this.logger.warn('AI observer could not record exhausted providers'); }
    throw new UserError('ИИ-сервисы сейчас недоступны или исчерпали бесплатную квоту. Попробуй немного позже.');
  }

  private async observe(event: AiAttempt): Promise<void> {
    try { await this.observer?.onAiAttempt(event); }
    catch { this.logger.warn('AI observer could not record provider attempt'); }
  }
}

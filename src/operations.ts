import type { Logger } from 'pino';
import type { AiAttempt, AiFeature, ProviderName } from './domain.js';
import type { Store } from './storage.js';
import type { AiObserver } from './ai/router.js';

type SendAlert = (chatId: number, text: string) => Promise<unknown>;
type ProviderBudget = {
  dailyTokens?: number;
  dailyRequests?: number;
  dailyUnits?: { limit: number; label: string; inputPerMillion: number; outputPerMillion: number };
};
type FailureWindow = { timestamps: number[] };

export type OperationsOptions = {
  enabled: boolean;
  adminIds: number[];
  transientFailureThreshold: number;
  cooldownMinutes: number;
  budgetAlertPercent: number;
  budgets: Partial<Record<ProviderName, ProviderBudget>>;
};

/** Aggregates operational telemetry and turns only durable anomalies into Telegram alerts. */
export class OperationsMonitor implements AiObserver {
  private readonly failures = new Map<string, FailureWindow>();
  private readonly activeIncidents = new Set<string>();
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly store: Pick<Store, 'recordAiAttempt' | 'providerDayUsage'>,
    private readonly send: SendAlert,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly options: OperationsOptions,
    private readonly now = Date.now,
  ) {}

  async onAiAttempt(event: AiAttempt): Promise<void> {
    try { await this.store.recordAiAttempt(event); }
    catch { this.logger.warn('Operational AI metric could not be stored'); }

    if (event.outcome === 'success') {
      this.failures.delete(`provider:${event.provider}`);
      const recovered = this.activeIncidents.has(`provider:${event.provider}`) || this.activeIncidents.has(`provider-config:${event.provider}`) || this.activeIncidents.has('ai:all');
      this.activeIncidents.delete(`provider:${event.provider}`);
      this.activeIncidents.delete(`provider-config:${event.provider}`);
      this.activeIncidents.delete('ai:all');
      if (recovered) await this.sendRecovery(`AI-провайдер ${event.provider} снова отвечает.`);
      await this.checkBudget(event.provider);
      return;
    }

    if ([401, 402, 403, 404].includes(event.statusCode)) {
      await this.alert(`provider-config:${event.provider}`,
        `🚨 AI ${event.provider}: постоянная ошибка HTTP ${event.statusCode}\nПроверь ключ, биллинг и название модели. Остальные провайдеры продолжат работать как fallback.`);
      return;
    }

    const count = this.noteFailure(`provider:${event.provider}`);
    if (count >= this.options.transientFailureThreshold) {
      await this.alert(`provider:${event.provider}`,
        `⚠️ AI ${event.provider}: ${count} ошибок за последние 5 минут\nHTTP: ${event.statusCode || 'сеть/тайм-аут'}. Провайдер временно деградировал; fallback остаётся активным.`);
    }
  }

  async onAiExhausted(feature: AiFeature): Promise<void> {
    await this.alert('ai:all',
      `🚨 Недоступны все AI-провайдеры\nНе выполнен запрос: ${feature === 'chat' ? 'диалог' : 'словарь'}. Пользователи уже получают ошибку — нужна проверка квот и ключей.`);
  }

  async noteUpdateError(): Promise<void> {
    const count = this.noteFailure('bot:update');
    if (count >= this.options.transientFailureThreshold) {
      await this.alert('bot:update', `⚠️ Бот: ${count} внутренних ошибок обработки за последние 5 минут\nПроверь логи приложения и PostgreSQL.`);
    }
  }

  async noteDatabaseError(): Promise<void> {
    const count = this.noteFailure('database');
    if (count >= 2) await this.alert('database', `🚨 PostgreSQL: ${count} ошибок соединения за последние 5 минут\nБот может терять возможность отвечать и сохранять историю.`);
  }

  async noteMaintenanceError(task: string): Promise<void> {
    const key = `maintenance:${task}`;
    const count = this.noteFailure(key);
    if (count >= this.options.transientFailureThreshold) {
      await this.alert(key, `⚠️ Служебная задача «${task}» завершилась ошибкой ${count} раз за 5 минут.`);
    }
  }

  async fatal(stage: string): Promise<void> {
    await this.alert(`fatal:${stage}`, `🚨 Бот остановлен на этапе «${stage}»\nТребуется ручная проверка процесса и логов.`);
  }

  private noteFailure(key: string): number {
    const cutoff = this.now() - 5 * 60_000;
    const window = this.failures.get(key) ?? { timestamps: [] };
    window.timestamps = window.timestamps.filter(timestamp => timestamp >= cutoff);
    window.timestamps.push(this.now());
    this.failures.set(key, window);
    return window.timestamps.length;
  }

  private async checkBudget(provider: ProviderName): Promise<void> {
    const budget = this.options.budgets[provider];
    if (!budget || !this.canAlert()) return;
    let usage;
    try { usage = await this.store.providerDayUsage(provider); }
    catch { this.logger.warn('Provider daily usage could not be read'); return; }
    const date = new Date(this.now()).toISOString().slice(0, 10);
    if (budget.dailyTokens) {
      const tokens = usage.inputTokens + usage.outputTokens;
      const percent = Math.floor(tokens / budget.dailyTokens * 100);
      if (percent >= 100) await this.alert(`budget:${provider}:tokens:100:${date}`, `🚨 ${provider}: дневной token budget исчерпан\n${tokens.toLocaleString('ru-RU')} / ${budget.dailyTokens.toLocaleString('ru-RU')} токенов (${percent}%).`);
      else if (percent >= this.options.budgetAlertPercent) await this.alert(`budget:${provider}:tokens:warn:${date}`, `⚠️ ${provider}: использовано ${percent}% дневного token budget\n${tokens.toLocaleString('ru-RU')} / ${budget.dailyTokens.toLocaleString('ru-RU')} токенов.`);
    }
    if (budget.dailyRequests) {
      const percent = Math.floor(usage.requests / budget.dailyRequests * 100);
      if (percent >= 100) await this.alert(`budget:${provider}:requests:100:${date}`, `🚨 ${provider}: дневной лимит запросов исчерпан\n${usage.requests} / ${budget.dailyRequests} запросов (${percent}%).`);
      else if (percent >= this.options.budgetAlertPercent) await this.alert(`budget:${provider}:requests:warn:${date}`, `⚠️ ${provider}: использовано ${percent}% дневного лимита\n${usage.requests} / ${budget.dailyRequests} запросов.`);
    }
    if (budget.dailyUnits?.limit) {
      const units = Math.ceil(usage.inputTokens * budget.dailyUnits.inputPerMillion / 1_000_000
        + usage.outputTokens * budget.dailyUnits.outputPerMillion / 1_000_000);
      const percent = Math.floor(units / budget.dailyUnits.limit * 100);
      if (percent >= 100) await this.alert(`budget:${provider}:units:100:${date}`, `🚨 ${provider}: бесплатный дневной объём исчерпан\n${units.toLocaleString('ru-RU')} / ${budget.dailyUnits.limit.toLocaleString('ru-RU')} ${budget.dailyUnits.label} (${percent}%).`);
      else if (percent >= this.options.budgetAlertPercent) await this.alert(`budget:${provider}:units:warn:${date}`, `⚠️ ${provider}: использовано ${percent}% бесплатного дневного объёма\n${units.toLocaleString('ru-RU')} / ${budget.dailyUnits.limit.toLocaleString('ru-RU')} ${budget.dailyUnits.label}.`);
    }
  }

  private async alert(key: string, text: string): Promise<void> {
    if (!this.canAlert()) return;
    const last = this.lastSent.get(key);
    if (last !== undefined && this.now() - last < this.options.cooldownMinutes * 60_000) return;
    this.lastSent.set(key, this.now());
    this.activeIncidents.add(key);
    await this.broadcast(text);
  }

  private async sendRecovery(text: string): Promise<void> {
    if (!this.canAlert()) return;
    await this.broadcast(`✅ Восстановление\n${text}`);
  }

  private canAlert(): boolean {
    return this.options.enabled && this.options.adminIds.length > 0;
  }

  private async broadcast(text: string): Promise<void> {
    const results = await Promise.allSettled(this.options.adminIds.map(chatId => this.send(chatId, text)));
    if (results.some(result => result.status === 'rejected')) this.logger.warn('One or more Telegram operational alerts could not be delivered');
  }
}

/** External dead-man heartbeat: the remote service alerts when this process stops pinging. */
export function startHeartbeat(
  url: string,
  intervalSeconds: number,
  logger: Pick<Logger, 'warn'>,
  fetcher: typeof fetch = fetch,
): () => void {
  if (!url) return () => undefined;
  const ping = async () => {
    try {
      const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      if (!response.ok) logger.warn('External healthcheck rejected a heartbeat');
    } catch { logger.warn('External healthcheck heartbeat failed'); }
  };
  void ping();
  const timer = setInterval(() => { void ping(); }, intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

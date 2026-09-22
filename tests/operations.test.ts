import { describe, expect, it, vi } from 'vitest';
import { OperationsMonitor } from '../src/operations.js';

const failure = { provider: 'groq' as const, feature: 'chat' as const, outcome: 'failure' as const, statusCode: 429, durationMs: 50, usage: { inputTokens: 0, outputTokens: 0 } };
const success = { ...failure, outcome: 'success' as const, statusCode: 0, usage: { inputTokens: 100, outputTokens: 20 } };

describe('operations monitoring', () => {
  it('detects remote voice degradation across its ten-minute retry cooldown', async () => {
    let now = Date.now();
    const send = vi.fn().mockResolvedValue(undefined);
    const monitor = new OperationsMonitor({ recordAiAttempt: vi.fn(), providerDayUsage: vi.fn() }, send, {warn:vi.fn()},
      {enabled:true, adminIds:[1], transientFailureThreshold:3, cooldownMinutes:30, budgetAlertPercent:80, budgets:{}}, () => now);
    for(let i=0;i<3;i++) { await monitor.noteSpeechResult('tts-remote', false); now += 600_000; }
    expect(send).toHaveBeenCalledTimes(1);
    expect(monitor.servicesHealthy()).toBe(true);
    await monitor.noteSpeechResult('tts-remote', true);
    expect(send).toHaveBeenCalledTimes(2);
    await monitor.noteSpeechResult('tts-remote', false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('alerts on a sustained anomaly, suppresses repeats and reports recovery', async () => {
    let now = 1_000;
    const send = vi.fn().mockResolvedValue(undefined);
    const store = { recordAiAttempt: vi.fn().mockResolvedValue(undefined), providerDayUsage: vi.fn().mockResolvedValue({ requests: 1, inputTokens: 100, outputTokens: 20 }) };
    const monitor = new OperationsMonitor(store, send, { warn: vi.fn() }, {
      enabled: true, adminIds: [42], transientFailureThreshold: 3, cooldownMinutes: 30, budgetAlertPercent: 80, budgets: {},
    }, () => now);
    await monitor.onAiAttempt(failure);
    await monitor.onAiAttempt(failure);
    expect(send).not.toHaveBeenCalled();
    await monitor.onAiAttempt(failure);
    await monitor.onAiAttempt(failure);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toContain('3 ошибок');
    now += 1_000;
    await monitor.onAiAttempt(success);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toContain('Восстановление');
  });

  it('alerts immediately for configuration failures and all-provider outages', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const store = { recordAiAttempt: vi.fn().mockResolvedValue(undefined), providerDayUsage: vi.fn() };
    const monitor = new OperationsMonitor(store, send, { warn: vi.fn() }, {
      enabled: true, adminIds: [42], transientFailureThreshold: 3, cooldownMinutes: 30, budgetAlertPercent: 80, budgets: {},
    });
    await monitor.onAiAttempt({ ...failure, statusCode: 401 });
    await monitor.onAiExhausted('chat');
    await monitor.onAiExhausted('chat');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]).toContain('ключ');
    expect(send.mock.calls[1]![1]).toContain('все AI-провайдеры');
  });
});

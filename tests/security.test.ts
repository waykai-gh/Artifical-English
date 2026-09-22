import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { testStore, answer, testConfig } from './helpers.js';
import { RuntimeHealth } from '../src/health.js';
import { OperationsMonitor, startHeartbeat } from '../src/operations.js';
import { Speech } from '../src/speech.js';
// @ts-expect-error standalone operator script intentionally has no TypeScript build dependency
import { runtimeValues, appKeys } from '../scripts/prepare-production.mjs';
import { envSchema } from '../src/config.js';
import { backupHealthy } from '../src/backup-health.js';

describe('audit regressions', () => {
  it('requires fresh backup and restore markers and rejects missing or future timestamps', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'english-backup-test-'));
    const now = Date.now();
    try {
      expect(await backupHealthy(directory, now)).toBe(false);
      for (const file of ['backup-success', 'restore-success']) writeFileSync(join(directory, file), String(Math.floor(now / 1000)));
      expect(await backupHealthy(directory, now)).toBe(true);
      expect(await backupHealthy(directory, now + 27 * 3600_000)).toBe(false);
      expect(await backupHealthy(directory, now - 3600_000)).toBe(false);
      writeFileSync(join(directory, 'restore-success'), String(Math.floor((now - 9 * 86400_000) / 1000)));
      expect(await backupHealthy(directory, now)).toBe(false);
    } finally {
      if (resolve(dirname(directory)) !== resolve(tmpdir())) throw Error('Unexpected test directory');
      rmSync(directory, {recursive:true});
    }
  });

  it('limits the global minute independently from daily quotas', async () => {
    const {db, store} = await testStore();
    try {
      expect(await store.claimRequest(1, 100, 0, 100, 1)).toBe(true);
      expect(await store.claimRequest(2, 100, 0, 100, 1)).toBe(false);
      await db.query("UPDATE global_request_limits SET minute = minute - interval '1 minute'");
      expect(await store.claimRequest(2, 100, 0, 100, 1)).toBe(true);
    } finally { await db.close(); }
  });
  it('retains quota across deletion, limits accounts globally, and purges expired pseudonyms', async () => {
    const { db, store } = await testStore();
    try {
      await store.settings(1);
      expect(await store.claimRequest(1, 1, 0, 2, 10)).toBe(true);
      await store.forget(1);
      await store.acceptConsent(1, 'test');
      expect(await store.claimRequest(1, 1, 0, 2, 10)).toBe(false);
      expect(await store.claimRequest(2, 100, 0, 2, 10)).toBe(true);
      expect(await store.claimRequest(3, 100, 0, 2, 10)).toBe(false);
      const limits = await db.query<{ subject: string }>('SELECT subject FROM request_limits');
      expect(limits.rows.every(row => /^[a-f0-9]{64}$/.test(row.subject))).toBe(true);
      await db.query("UPDATE request_limits SET day = day - 2");
      await store.cleanup();
      expect((await db.query('SELECT 1 FROM request_limits')).rows).toHaveLength(0);
    } finally { await db.close(); }
  });

  it('preserves legacy quotas when upgrading, filters admin retention, and stores only audit pseudonyms', async () => {
    const { db, store } = await testStore();
    try {
      await store.settings(1);
      await db.query("INSERT INTO request_usage VALUES (1, (now() AT TIME ZONE 'UTC')::date, 5, now())");
      await store.migrateLegacyLimits();
      await store.migrateLegacyLimits();
      await store.forget(1);
      expect(await store.claimRequest(1, 5, 0)).toBe(false);
      await store.settings(1);
      await store.saveTurn(1, 1, 'synthetic retention fixture', answer, 'groq');
      await db.query("UPDATE turns SET created_at = now() - interval '31 days'");
      expect(await store.adminRecentTurns(1)).toEqual([]);
      await store.auditAdminAccess(2, 'history', 1);
      const result = await db.query<{ actor: string; target: string; action: string }>('SELECT actor, target, action FROM admin_access_audit');
      expect(result.rows[0]?.actor).toMatch(/^[a-f0-9]{64}$/);
      expect(result.rows[0]?.target).toMatch(/^[a-f0-9]{64}$/);
      expect(result.rows[0]?.actor).not.toBe(result.rows[0]?.target);
      expect(result.rows[0]?.action).toBe('history');
    } finally { await db.close(); }
  });

  it('excludes unrelated credentials and preserves literal dollar signs', () => {
    const password = 'synthetic-db-password-$LITERAL';
    const values = runtimeValues(parseEnv(`POSTGRES_PASSWORD='${password}'\nGROQ_API_KEY='test-$UNCHANGED'\nPassword='not-for-container-$DANGER'\nIP=unused\n`), 'h'.repeat(32));
    expect(values.GROQ_API_KEY).toBe('test-$UNCHANGED');
    expect(new URL(values.DATABASE_URL).password).toBe(encodeURIComponent(password));
    expect(values.Password).toBeUndefined();
    expect(values.IP).toBeUndefined();
    expect(() => runtimeValues({}, 'h'.repeat(32))).toThrow('POSTGRES_PASSWORD');
    expect(() => runtimeValues({ POSTGRES_PASSWORD: 'english_local_only' }, 'h'.repeat(32))).toThrow();
    expect([...appKeys, 'DATABASE_URL', 'SECURITY_HMAC_KEY'].sort()).toEqual(Object.keys(envSchema.shape).sort());
    expect(readFileSync('compose.yaml', 'utf8')).not.toContain('env_file: .env');
  });

  it('reports all three hourly cleanup failures and recovery; failed delivery can retry', async () => {
    let now = Date.now();
    const send = vi.fn().mockResolvedValue(undefined);
    const monitor = new OperationsMonitor({ recordAiAttempt: vi.fn(), providerDayUsage: vi.fn() }, send, { warn: vi.fn() },
      { enabled: true, adminIds: [1], transientFailureThreshold: 3, cooldownMinutes: 30, budgetAlertPercent: 80, budgets: {} }, () => now);
    for (let i=0; i<3; i++) { await monitor.noteMaintenanceError('retention'); now += 3600_000; }
    expect(send).toHaveBeenCalledTimes(3);
    expect(monitor.servicesHealthy()).toBe(false);
    await monitor.noteMaintenanceSuccess('retention');
    expect(monitor.servicesHealthy()).toBe(true);
    expect(send).toHaveBeenCalledTimes(4);
    send.mockRejectedValueOnce(new Error('test delivery failure'));
    await monitor.onAiExhausted('chat');
    await monitor.onAiExhausted('chat');
    expect(send).toHaveBeenCalledTimes(6);
  });

  it('does not report empty speech as an outage; reports STT and TTS provider outages', async () => {
    const monitor = { noteSpeechResult: vi.fn().mockResolvedValue(undefined) };
    const failedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    const speech = new Speech(testConfig({ LOCAL_TTS_FALLBACK: 'false' }), failedFetch, monitor);
    await expect(speech.transcribe(Buffer.from('audio'), 'audio/ogg', 'test.ogg')).rejects.toThrow();
    expect(monitor.noteSpeechResult).toHaveBeenCalledWith('stt', false);
    await expect(speech.speak('Hello')).rejects.toThrow();
    expect(monitor.noteSpeechResult).toHaveBeenCalledWith('tts', false);
    monitor.noteSpeechResult.mockClear();
    const empty = new Speech(testConfig(), vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: '' })), monitor);
    await expect(empty.transcribe(Buffer.from('audio'), 'audio/ogg', 'test.ogg')).rejects.toThrow();
    expect(monitor.noteSpeechResult).toHaveBeenCalledWith('stt', true);
    expect(monitor.noteSpeechResult).not.toHaveBeenCalledWith('stt', false);
  });

  it('fails health on a stale poll or broken DB and stops successful heartbeats on service failure', async () => {
    let now = Date.now();
    let services = true;
    const database = vi.fn().mockResolvedValue(undefined);
    const health = new RuntimeHealth(database, () => true, () => services, () => now);
    expect((await health.snapshot()).ready).toBe(false);
    health.pollSucceeded();
    expect((await health.snapshot()).ready).toBe(true);
    services = false;
    expect((await health.snapshot()).live).toBe(true);
    expect((await health.snapshot()).ready).toBe(false);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(''));
    const stop = startHeartbeat('https://example.test/health', 60, { warn: vi.fn() }, fetcher, async () => (await health.snapshot()).ready);
    await new Promise(resolve => setImmediate(resolve));
    stop();
    expect(fetcher).not.toHaveBeenCalled();
    now += 700_000;
    expect((await health.snapshot()).live).toBe(false);
    health.pollSucceeded();
    database.mockRejectedValue(new Error('test database failure'));
    expect((await health.snapshot()).database).toBe(false);
  });
});

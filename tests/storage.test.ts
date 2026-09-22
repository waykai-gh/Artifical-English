import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Store } from '../src/storage.js';
import { answer, testStore } from './helpers.js';

describe('PostgreSQL persistence', () => {
  let db: PGlite;
  let store: Store;
  beforeEach(async () => { ({ db, store } = await testStore(2)); });
  afterEach(async () => { await db.close(); });

  it('records consent separately and never onboards a user without it', async () => {
    expect(await store.hasConsent(1, 'v1')).toBe(false);
    await expect(store.completeOnboarding(1, 'A0')).rejects.toThrow('Consent is required');
    expect((await db.query('SELECT * FROM app_users')).rows).toEqual([]);
    await store.acceptConsent(1, 'v1');
    expect(await store.hasConsent(1, 'v1')).toBe(true);
    expect(await store.hasConsent(1, 'v2')).toBe(false);
    expect(await store.onboardingCompleted(1)).toBe(false);
    await store.completeOnboarding(1, 'A0');
    expect(await store.onboardingCompleted(1)).toBe(true);
    expect((await store.settings(1)).level).toBe('A0');
  });

  it('isolates users, orders and bounds history, and deduplicates updates', async () => {
    await store.settings(1); await store.settings(2);
    for (let id = 1; id <= 3; id++) await store.saveTurn(1, id, `message ${id}`, answer, 'groq');
    await store.saveTurn(1, 3, 'duplicate', answer, 'groq');
    await store.saveTurn(2, 3, 'other user', answer, 'groq');
    const history = await store.history(1);
    expect(history.filter(m => m.role === 'user').map(m => m.content)).toEqual(['message 2', 'message 3']);
    expect(history).toHaveLength(4);
    expect(await store.stats(1)).toEqual({ turns: 3, corrections: 3, vocabulary: 0 });
    expect(await store.hasTurn(1, 3)).toBe(true);
    expect(await store.hasTurn(2, 1)).toBe(false);
  });

  it('stores phrases per user, updates duplicates, paginates, finds and deletes them', async () => {
    const first = (await store.saveVocabulary(1, 'Take off', 'взлетать'))!;
    const updated = (await store.saveVocabulary(1, 'take off', 'взлетать; снимать'))!;
    expect(updated.id).toBe(first.id);
    expect((await store.listVocabulary(1, 1)).total).toBe(1);
    expect((await store.findVocabulary(1, 'TAKE OFF'))?.translation).toBe('взлетать; снимать');
    expect((await store.findVocabulary(1, `#${first.id}`))?.term).toBe('take off');
    expect(await store.findVocabulary(2, String(first.id))).toBeNull();
    for (let i = 0; i < 11; i++) await store.saveVocabulary(1, `word ${i}`, `слово ${i}`);
    const secondPage = await store.listVocabulary(1, 2, 10);
    expect(secondPage.total).toBe(12);
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.pages).toBe(2);
    expect(await store.deleteVocabulary(1, first.id)).toBe(true);
    expect(await store.deleteVocabulary(1, first.id)).toBe(false);
  });

  it('limits new vocabulary without blocking an update at the limit', async () => {
    const first = await store.saveVocabulary(1, 'one', 'один', 1);
    expect(first).not.toBeNull();
    expect(await store.saveVocabulary(1, 'two', 'два', 1)).toBeNull();
    expect((await store.saveVocabulary(1, 'ONE', 'единица', 1))?.translation).toBe('единица');
  });

  it('normalizes phrase whitespace in saves and lookup', async () => {
    const first = (await store.saveVocabulary(1, '  take\t off  ', 'снимать\n одежду'))!;
    expect(first.term).toBe('take off');
    expect(first.translation).toBe('снимать одежду');
    expect((await store.findVocabulary(1, ' TAKE\n\tOFF '))?.id).toBe(first.id);
    expect((await store.saveVocabulary(1, 'take   off', 'взлетать'))?.id).toBe(first.id);
    expect((await store.listVocabulary(1, 1)).total).toBe(1);
  });

  it('keeps the vocabulary limit during competing saves and permits updates after the limit is lowered', async () => {
    // PGlite exercises the actual SQL path; real multi-connection contention is
    // covered by the function's per-user row lock in PostgreSQL.
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.saveVocabulary(1, `word ${index}`, `слово ${index}`, 3)));
    expect(attempts.filter(Boolean)).toHaveLength(3);
    const existing = attempts.find(item => item !== null)!;
    expect((await store.saveVocabulary(1, existing.term, 'обновлённый перевод', 1))?.id).toBe(existing.id);
    expect(await store.saveVocabulary(1, 'another', 'другое', 1)).toBeNull();
    expect((await store.listVocabulary(1, 1)).total).toBe(3);
    expect(await store.saveVocabulary(2, 'another', 'другое', 1)).not.toBeNull();
  });

  it('persists settings across store instances and resets only conversation', async () => {
    await store.updateSettings(1, { level: 'A2', voiceMode: 'off' });
    await store.saveTurn(1, 1, 'hello', answer, 'groq');
    await store.clear(1);
    expect(await store.history(1)).toEqual([]);
    expect((await store.settings(1)).level).toBe('A2');
    expect((await store.settings(2)).level).toBe('B1');
  });

  it('atomically limits competing requests and resets daily quota on UTC boundary', async () => {
    await store.settings(1);
    const claims = await Promise.all([store.claimRequest(1, 1, 0), store.claimRequest(1, 1, 0)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await db.query("UPDATE request_limits SET day = day - 1, last_request = now() - interval '1 day'");
    expect(await store.claimRequest(1, 1, 0)).toBe(true);
    expect(await store.claimRequest(1, 100, 10)).toBe(false);
  });

  it('aggregates operator activity and AI health without storing message-level analytics', async () => {
    await store.settings(1); await store.settings(2); await store.settings(3);
    await store.saveTurn(1, 1, 'hello', answer, 'groq');
    await store.saveTurn(1, 2, 'again', answer, 'groq');
    await store.saveTurn(1, 3, 'third', answer, 'groq');
    await store.saveTurn(2, 4, 'hello', answer, 'cloudflare');
    await db.query("UPDATE turns SET created_at = now() - interval '1 day' WHERE user_id = 1 AND update_id = 1");
    await store.saveVocabulary(1, 'take off', 'взлетать');
    await store.recordAiAttempt({ provider: 'groq', feature: 'chat', outcome: 'success', statusCode: 0, durationMs: 500, usage: { inputTokens: 1200, outputTokens: 100 } });
    await store.recordAiAttempt({ provider: 'groq', feature: 'chat', outcome: 'failure', statusCode: 429, durationMs: 100, usage: { inputTokens: 0, outputTokens: 0 } });
    const stats = await store.operationsStats();
    expect(stats.users.total).toBe(3);
    expect(stats.activity.active7d).toBe(2);
    expect(stats.activity.engaged7d).toBe(1);
    expect(stats.activity.returning7d).toBe(1);
    expect(stats.vocabulary).toEqual({ users: 1, items: 1 });
    expect(stats.providersToday[0]).toEqual(expect.objectContaining({ provider: 'groq', attempts: 2, failures: 1, averageMs: 300, inputTokens: 1200, outputTokens: 100 }));
    expect(await store.providerDayUsage('groq')).toEqual({ requests: 2, inputTokens: 1200, outputTokens: 100 });
  });

  it('provides paginated support views without exposing PostgreSQL publicly', async () => {
    await store.settings(1); await store.settings(2);
    await store.updateSettings(2, { level: 'A1' });
    await store.saveTurn(2, 1, 'hello', answer, 'groq');
    await store.saveVocabulary(2, 'take off', 'взлетать');
    const users = await store.adminUsers(1, 1);
    expect(users.total).toBe(2);
    expect(users.pages).toBe(2);
    const detail = await store.adminUser(2);
    expect(detail).toEqual(expect.objectContaining({ id: 2, turns: 1, vocabulary: 1, settings: expect.objectContaining({ level: 'A1' }) }));
    expect(await store.adminUser(999)).toBeNull();
    expect(await store.adminRecentTurns(2)).toEqual([expect.objectContaining({ userText: 'hello', reply: answer.reply, provider: 'groq' })]);
    expect(await store.adminVocabulary(2)).toEqual({ total: 1, items: [expect.objectContaining({ term: 'take off', translation: 'взлетать' })] });
  });

  it('excludes expired turns before cleanup and deletes all user data on forget', async () => {
    await store.settings(1); await store.settings(2);
    await store.saveTurn(1, 1, 'expired', answer, 'groq');
    await db.query("UPDATE turns SET created_at = now() - interval '31 days' WHERE user_id = 1");
    expect(await store.history(1)).toEqual([]);
    expect(await store.adminRecentTurns(1)).toEqual([]);
    await store.cleanup();
    expect(await store.hasTurn(1, 1)).toBe(false);
    await store.claimRequest(1, 100, 0);
    await store.saveTurn(1, 2, 'new', answer, 'groq');
    await store.saveVocabulary(1, 'remember me', 'запомни меня');
    await store.forget(1);
    expect((await db.query('SELECT * FROM request_usage')).rows).toEqual([]);
    expect(await store.claimRequest(1, 1, 0)).toBe(false);
    expect((await db.query('SELECT * FROM turns')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM app_users')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM vocabulary_items')).rows).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Store } from '../src/storage.js';
import { answer, testStore } from './helpers.js';

describe('PostgreSQL persistence', () => {
  let db: PGlite;
  let store: Store;
  beforeEach(async () => { ({ db, store } = await testStore(2)); });
  afterEach(async () => { await db.close(); });

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
    await db.query("UPDATE request_usage SET day = day - 1, last_request = now() - interval '1 day' WHERE user_id = 1");
    expect(await store.claimRequest(1, 1, 0)).toBe(true);
    expect(await store.claimRequest(1, 100, 10)).toBe(false);
  });

  it('excludes expired turns before cleanup and deletes all user data on forget', async () => {
    await store.settings(1); await store.settings(2);
    await store.saveTurn(1, 1, 'expired', answer, 'groq');
    await db.query("UPDATE turns SET created_at = now() - interval '31 days' WHERE user_id = 1");
    expect(await store.history(1)).toEqual([]);
    await store.cleanup();
    expect(await store.hasTurn(1, 1)).toBe(false);
    await store.claimRequest(1, 100, 0);
    await store.saveTurn(1, 2, 'new', answer, 'groq');
    await store.saveVocabulary(1, 'remember me', 'запомни меня');
    await store.forget(1);
    expect((await db.query('SELECT * FROM request_usage')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM turns')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM app_users')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM vocabulary_items')).rows).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { Store } from '../src/storage.js';
import { createPending, PENDING_TTL_MS } from '../src/ui-state.js';
import { answer, testStore } from './helpers.js';

describe('Persistent interaction state', () => {
  let db: PGlite;
  let store: Store;
  beforeEach(async () => { ({ db, store } = await testStore()); });
  afterEach(async () => { await db.close(); });

  it('starts empty and persists a vocabulary prompt across store instances', async () => {
    expect(await store.getUiState(1)).toEqual({ pending: null, tipFlags: [], conversationCount: 0 });
    const pending = { ...createPending('translation', 'take off'), promptMessageId: 42 };
    await store.setPending(1, pending);
    await store.markTipSeen(1, 'vocabulary');
    await store.noteConversation(1);
    const restored = new Store({ query: async (sql, params) => ({ rows: (await db.query<Record<string, unknown>>(sql, params)).rows }) }, await store.settings(1), 8, 30);
    expect(await restored.getUiState(1)).toEqual({ pending, tipFlags: ['vocabulary'], conversationCount: 1 });
    expect(await restored.getUiState(2)).toEqual({ pending: null, tipFlags: [], conversationCount: 0 });
  });

  it('allows a transition once and rejects stale nonces and other users', async () => {
    const first = createPending('term');
    const next = createPending('translation', 'take off');
    await store.setPending(1, first);
    expect(await store.setPending(2, next, first.nonce)).toBe(false);
    const transitions = await Promise.all([
      store.setPending(1, next, first.nonce),
      store.setPending(1, next, first.nonce),
    ]);
    expect(transitions.filter(Boolean)).toHaveLength(1);
    expect(await store.setPending(1, null, first.nonce)).toBe(false);
    expect((await store.getUiState(1)).pending).toEqual(next);
    expect(await store.setPending(1, null, next.nonce)).toBe(true);
    expect(await store.setPending(1, null, next.nonce)).toBe(false);
  });

  it('expires prompts and prevents expired confirmations from being consumed', async () => {
    const pending = createPending('confirm', 'forget');
    await store.setPending(1, { ...pending, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await store.getUiState(1)).pending).toBeNull();
    expect(await store.setPending(1, null, pending.nonce)).toBe(false);
    await store.cleanup();
    expect((await db.query<{ pending: unknown }>('SELECT pending FROM app_ui_state WHERE user_id = 1')).rows[0]?.pending).toBeNull();
  });

  it('atomically marks each tip once and counts concurrent conversations', async () => {
    const marks = await Promise.all(Array.from({ length: 5 }, () => store.markTipSeen(1, 'voice')));
    expect(marks.filter(Boolean)).toHaveLength(1);
    await Promise.all([store.markTipSeen(1, 'settings'), store.markTipSeen(1, 'vocabulary')]);
    const counts = await Promise.all(Array.from({ length: 5 }, () => store.noteConversation(1)));
    expect(counts.sort()).toEqual([1, 2, 3, 4, 5]);
    const state = await store.getUiState(1);
    expect(state.tipFlags.sort()).toEqual(['settings', 'vocabulary', 'voice']);
    expect(state.conversationCount).toBe(5);
    expect(await store.markTipSeen(2, 'voice')).toBe(true);
  });

  it('reset cancels the active flow and preserves dictionary, tips and progress; forget cascades everything', async () => {
    await store.setPending(1, createPending('confirm', 'deleteWord', 12));
    await store.markTipSeen(1, 'vocabulary');
    await store.noteConversation(1);
    await store.saveVocabulary(1, 'take off', 'взлетать');
    await store.saveTurn(1, 1, 'hello', answer, 'groq');
    await store.clear(1);
    expect(await store.history(1)).toEqual([]);
    expect(await store.getUiState(1)).toEqual({ pending: null, tipFlags: ['vocabulary'], conversationCount: 1 });
    expect((await store.listVocabulary(1, 1)).total).toBe(1);
    await store.setPending(2, createPending('term'));
    await store.forget(1);
    const users = await db.query<{ user_id: number }>('SELECT user_id::int FROM app_ui_state');
    expect(users.rows).toEqual([{ user_id: 2 }]);
    expect(await store.getUiState(1)).toEqual({ pending: null, tipFlags: [], conversationCount: 0 });
  });
});

describe('Pending action validation', () => {
  it('uses different UUIDs, a fifteen minute lifetime and validates deletion targets', () => {
    const before = Date.now();
    const first = createPending('term');
    const second = createPending('term');
    expect(first.nonce).not.toBe(second.nonce);
    expect(Date.parse(first.expiresAt)).toBeGreaterThanOrEqual(before + PENDING_TTL_MS);
    expect(Date.parse(first.expiresAt)).toBeLessThanOrEqual(Date.now() + PENDING_TTL_MS);
    expect(() => createPending('confirm', 'deleteWord')).toThrow();
    expect(() => createPending('translation', '')).toThrow();
    expect(createPending('confirm', 'reset').action).toBe('reset');
  });
});

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createPool, migrate, Store } from '../src/storage.js';
import { acquirePollingLock } from '../src/runtime-health.js';
import { defaults } from '../src/config.js';
import { testConfig } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('real PostgreSQL integration', () => {
  let pool: ReturnType<typeof createPool>;
  let store: Store;
  beforeAll(async () => {
    if (!url || new URL(url).pathname !== '/english_ci') throw Error('Requires a dedicated english_ci database');
    pool = createPool(url);
    await Promise.all([migrate(pool), migrate(pool)]);
    store = new Store(pool, defaults(testConfig()), 8, 30, 6000, testConfig().SECURITY_HMAC_KEY);
  });
  afterAll(async () => { await pool?.end(); });
  it('enforces a single poller across separate connections', async () => {
    const release = await acquirePollingLock(pool, 123, () => undefined);
    try { await expect(acquirePollingLock(pool, 123, () => undefined)).rejects.toThrow('already running'); }
    finally { release(); }
  });
  it('serializes global quota and user quota in real concurrent transactions', async () => {
    const batch = await Promise.all(Array.from({length: 20}, (_, i) => store.claimRequest(1000+i, 100, 0, 5, 30)));
    expect(batch.filter(Boolean)).toHaveLength(5);
    const outcomes = await Promise.all(Array.from({length: 10}, () => store.claimRequest(999, 1, 0, 100, 30)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await store.forget(999);
    expect(await store.claimRequest(999, 1, 0, 100, 30)).toBe(false);
  });
});

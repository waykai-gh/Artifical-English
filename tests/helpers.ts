import { PGlite } from '@electric-sql/pglite';
import { readConfig, defaults } from '../src/config.js';
import { schemaSql, Store } from '../src/storage.js';

export function testConfig(extra: NodeJS.ProcessEnv = {}) {
  return readConfig({ BOT_TOKEN: `123456:${'x'.repeat(35)}`, DATABASE_URL: 'postgresql://test:test@localhost/test', GROQ_API_KEY: 'test-key', ...extra });
}

export async function testStore(historyTurns = 8) {
  const db = new PGlite();
  await db.exec(schemaSql);
  const store = new Store({ query: async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params);
    return { rows: result.rows };
  } }, defaults(testConfig()), historyTurns, 30);
  return { db, store };
}

export const answer = { reply: 'That sounds nice! What did you buy?', corrections: [{ original: 'I go', corrected: 'I went', explanation: 'Для прошлого используем Past Simple: went.' }] };
export const vocabularyUsage = {
  meaning: 'Фразовый глагол с несколькими значениями: взлетать или снимать одежду.',
  register: 'Нейтральное и очень распространённое выражение.',
  patterns: [{ pattern: 'take something off', explanation: 'Дополнение ставится между частями глагола.' }],
  examples: [
    { english: 'The plane took off on time.', translation: 'Самолёт взлетел вовремя.' },
    { english: 'Please take your shoes off.', translation: 'Пожалуйста, сними обувь.' },
  ],
  commonMistakes: ['С местоимением говорим take it off, а не take off it.'],
};

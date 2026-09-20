import { Pool } from 'pg';
import { answerSchema, settingsSchema, type AiAttempt, type Answer, type Message, type ProviderName, type Settings } from './domain.js';
import { pendingActionSchema, type PendingAction, type UiState } from './ui-state.js';

export const schemaSql = `
CREATE TABLE IF NOT EXISTS app_users (
  id BIGINT PRIMARY KEY,
  settings JSONB NOT NULL,
  consent_version TEXT,
  consented_at TIMESTAMPTZ,
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS consent_version TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS turns (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  update_id BIGINT NOT NULL,
  user_text TEXT NOT NULL,
  answer JSONB NOT NULL,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, update_id)
);
CREATE INDEX IF NOT EXISTS turns_user_id_id ON turns(user_id, id DESC);
CREATE INDEX IF NOT EXISTS turns_created_at ON turns(created_at);
CREATE TABLE IF NOT EXISTS request_usage (
  user_id BIGINT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  requests INTEGER NOT NULL,
  last_request TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS vocabulary_items (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  term TEXT NOT NULL CHECK (char_length(term) BETWEEN 1 AND 160),
  translation TEXT NOT NULL CHECK (char_length(translation) BETWEEN 1 AND 400),
  term_key TEXT GENERATED ALWAYS AS (lower(btrim(term))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, term_key)
);
CREATE INDEX IF NOT EXISTS vocabulary_items_user_updated ON vocabulary_items(user_id, updated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS app_ui_state (
  user_id BIGINT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  pending JSONB,
  tip_flags JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tip_flags) = 'array'),
  conversation_count INTEGER NOT NULL DEFAULT 0 CHECK (conversation_count >= 0)
);
CREATE TABLE IF NOT EXISTS ai_metrics_hourly (
  bucket TIMESTAMPTZ NOT NULL,
  provider TEXT NOT NULL,
  feature TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  status_code INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  PRIMARY KEY (bucket, provider, feature, outcome, status_code)
);
CREATE INDEX IF NOT EXISTS ai_metrics_hourly_bucket ON ai_metrics_hourly(bucket DESC);

-- Separate commands inside a VOLATILE function take fresh READ COMMITTED
-- snapshots after the user lock is acquired. A single count/insert CTE would
-- still see its pre-lock snapshot and could exceed the limit under contention.
CREATE OR REPLACE FUNCTION save_vocabulary_item(p_user_id BIGINT, p_term TEXT, p_translation TEXT, p_limit INTEGER)
RETURNS SETOF vocabulary_items LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM id FROM app_users WHERE id = p_user_id FOR UPDATE;
  RETURN QUERY UPDATE vocabulary_items SET term = p_term, translation = p_translation, updated_at = now()
    WHERE user_id = p_user_id AND term_key = lower(btrim(p_term)) RETURNING *;
  IF FOUND THEN RETURN; END IF;
  IF (SELECT count(*) FROM vocabulary_items WHERE user_id = p_user_id) >= p_limit THEN RETURN; END IF;
  RETURN QUERY INSERT INTO vocabulary_items(user_id, term, translation)
    VALUES (p_user_id, p_term, p_translation) RETURNING *;
END;
$$;
`;

// A minimal interface also lets tests run the same SQL on embedded PostgreSQL.
export interface Database {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export type VocabularyItem = { id: number; term: string; translation: string };
export type ProviderOperations = {
  provider: string;
  attempts: number;
  failures: number;
  averageMs: number;
  inputTokens: number;
  outputTokens: number;
};
export type OperationsStats = {
  users: { total: number; new24h: number; new7d: number };
  activity: { active24h: number; active7d: number; active30d: number; turns24h: number; turns7d: number; engaged7d: number; returning7d: number };
  vocabulary: { users: number; items: number };
  providersToday: ProviderOperations[];
};
export type AdminUserRecord = {
  id: number;
  settings: Settings;
  createdAt: string;
  consentedAt: string | null;
  consentVersion: string | null;
  onboardingCompleted: boolean;
  turns: number;
  vocabulary: number;
  lastActive: string;
};
export type AdminTurn = { userText: string; reply: string; corrections: number; provider: string; createdAt: string };

export function createPool(connectionString: string) {
  return new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000 });
}

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(71824001)');
    await client.query(schemaSql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export class Store {
  constructor(private readonly db: Database, private readonly initial: Settings, private readonly historyTurns: number, private readonly retentionDays: number, private readonly historyMaxChars = 6000) {}

  async hasConsent(userId: number, version: string): Promise<boolean> {
    const result = await this.db.query('SELECT consent_version FROM app_users WHERE id = $1', [userId]);
    return result.rows[0]?.consent_version === version;
  }

  async acceptConsent(userId: number, version: string): Promise<void> {
    await this.db.query(`INSERT INTO app_users(id, settings, consent_version, consented_at)
      VALUES ($1, $2::jsonb, $3, now())
      ON CONFLICT (id) DO UPDATE SET consent_version = EXCLUDED.consent_version, consented_at = EXCLUDED.consented_at`,
    [userId, JSON.stringify(this.initial), version]);
  }

  async onboardingCompleted(userId: number): Promise<boolean> {
    const result = await this.db.query('SELECT onboarding_completed FROM app_users WHERE id = $1', [userId]);
    return result.rows[0]?.onboarding_completed === true;
  }

  async completeOnboarding(userId: number, level: Settings['level']): Promise<Settings> {
    const existing = await this.db.query('SELECT settings FROM app_users WHERE id = $1 AND consent_version IS NOT NULL', [userId]);
    if (!existing.rows.length) throw new Error('Consent is required before onboarding');
    const next = settingsSchema.parse({ ...settingsSchema.parse(existing.rows[0]?.settings), level });
    const result = await this.db.query(`UPDATE app_users SET settings = $2::jsonb, onboarding_completed = TRUE
      WHERE id = $1 AND consent_version IS NOT NULL RETURNING settings`, [userId, JSON.stringify(next)]);
    return settingsSchema.parse(result.rows[0]?.settings);
  }

  async settings(userId: number): Promise<Settings> {
    await this.db.query('INSERT INTO app_users(id, settings) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING', [userId, JSON.stringify(this.initial)]);
    const result = await this.db.query('SELECT settings FROM app_users WHERE id = $1', [userId]);
    return settingsSchema.parse(result.rows[0]?.settings);
  }

  async updateSettings(userId: number, patch: Partial<Settings>): Promise<Settings> {
    const next = settingsSchema.parse({ ...await this.settings(userId), ...patch });
    await this.db.query('UPDATE app_users SET settings = $2::jsonb WHERE id = $1', [userId, JSON.stringify(next)]);
    return next;
  }

  async history(userId: number): Promise<Message[]> {
    const result = await this.db.query(`SELECT user_text, answer FROM turns
      WHERE user_id = $1 AND created_at > now() - $3 * interval '1 day'
      ORDER BY id DESC LIMIT $2`, [userId, this.historyTurns, this.retentionDays]);
    const messages: Message[] = [];
    let characters = 0;
    for (const row of result.rows) {
      const text = String(row.user_text);
      const content = JSON.stringify(answerSchema.parse(row.answer));
      if (characters + text.length + content.length > this.historyMaxChars) break;
      characters += text.length + content.length;
      messages.unshift({ role: 'user', content: text }, { role: 'assistant', content });
    }
    return messages;
  }

  async hasTurn(userId: number, updateId: number): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM turns WHERE user_id = $1 AND update_id = $2', [userId, updateId])).rows.length > 0;
  }

  async saveTurn(userId: number, updateId: number, text: string, answer: Answer, provider: string): Promise<void> {
    await this.db.query(`INSERT INTO turns(user_id, update_id, user_text, answer, provider)
      VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, update_id) DO NOTHING`,
    [userId, updateId, text, JSON.stringify(answerSchema.parse(answer)), provider]);
  }

  async claimRequest(userId: number, dailyLimit: number, cooldownSeconds: number): Promise<boolean> {
    const result = await this.db.query(`INSERT INTO request_usage(user_id, day, requests, last_request)
      VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1, now())
      ON CONFLICT (user_id) DO UPDATE SET
        day = EXCLUDED.day,
        requests = CASE WHEN request_usage.day = EXCLUDED.day THEN request_usage.requests + 1 ELSE 1 END,
        last_request = now()
      WHERE (request_usage.day <> EXCLUDED.day OR request_usage.requests < $2)
        AND request_usage.last_request <= now() - $3 * interval '1 second'
      RETURNING user_id`, [userId, dailyLimit, cooldownSeconds]);
    return result.rows.length > 0;
  }

  async clear(userId: number): Promise<void> {
    await this.db.query('DELETE FROM turns WHERE user_id = $1', [userId]);
    await this.db.query('UPDATE app_ui_state SET pending = NULL WHERE user_id = $1', [userId]);
  }

  async getUiState(userId: number): Promise<UiState> {
    await this.settings(userId);
    const result = await this.db.query(`SELECT pending, tip_flags, conversation_count,
      pending IS NOT NULL AND (pending->>'expiresAt')::timestamptz > now() AS pending_active
      FROM app_ui_state WHERE user_id = $1`, [userId]);
    const row = result.rows[0];
    if (!row) return { pending: null, tipFlags: [], conversationCount: 0 };
    const parsed = pendingActionSchema.safeParse(row.pending);
    return {
      pending: row.pending_active === true && parsed.success ? parsed.data : null,
      tipFlags: Array.isArray(row.tip_flags) ? row.tip_flags.filter((tip): tip is string => typeof tip === 'string') : [],
      conversationCount: Number(row.conversation_count),
    };
  }

  /** expectedNonce makes a transition conditional on the current, unexpired flow. */
  async setPending(userId: number, pending: PendingAction | null, expectedNonce?: string): Promise<boolean> {
    const value = pending === null ? null : JSON.stringify(pendingActionSchema.parse(pending));
    if (expectedNonce !== undefined) {
      const result = await this.db.query(`UPDATE app_ui_state SET pending = $2::jsonb
        WHERE user_id = $1 AND pending->>'nonce' = $3 AND (pending->>'expiresAt')::timestamptz > now()
        RETURNING user_id`, [userId, value, expectedNonce]);
      return result.rows.length > 0;
    }
    await this.settings(userId);
    await this.db.query(`INSERT INTO app_ui_state(user_id, pending) VALUES ($1, $2::jsonb)
      ON CONFLICT (user_id) DO UPDATE SET pending = EXCLUDED.pending`, [userId, value]);
    return true;
  }

  /** Returns true once per user/tip, including concurrent attempts. */
  async markTipSeen(userId: number, tipKey: string): Promise<boolean> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(tipKey)) throw new Error('Invalid tip key');
    await this.settings(userId);
    const result = await this.db.query(`INSERT INTO app_ui_state(user_id, tip_flags)
      VALUES ($1, jsonb_build_array($2::text))
      ON CONFLICT (user_id) DO UPDATE SET tip_flags = app_ui_state.tip_flags || EXCLUDED.tip_flags
      WHERE NOT (app_ui_state.tip_flags ? $2::text) RETURNING user_id`, [userId, tipKey]);
    return result.rows.length > 0;
  }

  async noteConversation(userId: number): Promise<number> {
    await this.settings(userId);
    const result = await this.db.query(`INSERT INTO app_ui_state(user_id, conversation_count) VALUES ($1, 1)
      ON CONFLICT (user_id) DO UPDATE SET conversation_count = app_ui_state.conversation_count + 1
      RETURNING conversation_count`, [userId]);
    return Number(result.rows[0]?.conversation_count);
  }

  async saveVocabulary(userId: number, term: string, translation: string, limit = 1000): Promise<VocabularyItem | null> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Vocabulary limit must be a positive integer');
    term = normalizeSpaces(term);
    translation = normalizeSpaces(translation);
    await this.settings(userId);
    const result = await this.db.query('SELECT id, term, translation FROM save_vocabulary_item($1, $2, $3, $4)', [userId, term, translation, limit]);
    return result.rows[0] ? vocabularyItem(result.rows[0]) : null;
  }

  async listVocabulary(userId: number, page: number, pageSize = 10): Promise<{ items: VocabularyItem[]; total: number; pages: number; page: number }> {
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('Invalid vocabulary pagination');
    await this.settings(userId);
    const count = await this.db.query('SELECT count(*)::int AS total FROM vocabulary_items WHERE user_id = $1', [userId]);
    const total = Number(count.rows[0]?.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(Math.max(1, page), pages);
    const result = await this.db.query(`SELECT id, term, translation FROM vocabulary_items
      WHERE user_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [userId, pageSize, (normalizedPage - 1) * pageSize]);
    return { items: result.rows.map(vocabularyItem), total, pages, page: normalizedPage };
  }

  async findVocabulary(userId: number, reference: string): Promise<VocabularyItem | null> {
    reference = normalizeSpaces(reference);
    await this.settings(userId);
    const idText = reference.replace(/^#/, '');
    const id = Number(idText);
    const byId = /^#?\d+$/.test(reference) && Number.isSafeInteger(id) && id > 0;
    const result = await this.db.query(`SELECT id, term, translation FROM vocabulary_items
      WHERE user_id = $1 AND ${byId ? 'id = $2' : 'term_key = lower(btrim($2))'} LIMIT 1`, [userId, byId ? id : reference]);
    return result.rows[0] ? vocabularyItem(result.rows[0]) : null;
  }

  async deleteVocabulary(userId: number, id: number): Promise<boolean> {
    const result = await this.db.query('DELETE FROM vocabulary_items WHERE user_id = $1 AND id = $2 RETURNING id', [userId, id]);
    return result.rows.length > 0;
  }

  async forget(userId: number): Promise<void> {
    await this.db.query('DELETE FROM app_users WHERE id = $1', [userId]);
  }

  async cleanup(): Promise<void> {
    await this.db.query("DELETE FROM turns WHERE created_at <= now() - $1 * interval '1 day'", [this.retentionDays]);
    await this.db.query("DELETE FROM request_usage WHERE day < (now() AT TIME ZONE 'UTC')::date - 2");
    await this.db.query("UPDATE app_ui_state SET pending = NULL WHERE pending IS NOT NULL AND (pending->>'expiresAt')::timestamptz <= now()");
    await this.db.query("DELETE FROM ai_metrics_hourly WHERE bucket < now() - interval '90 days'");
  }

  async stats(userId: number): Promise<{ turns: number; corrections: number; vocabulary: number }> {
    const result = await this.db.query(`SELECT count(*)::int AS turns,
      coalesce(sum(jsonb_array_length(answer->'corrections')), 0)::int AS corrections
      FROM turns WHERE user_id = $1 AND created_at > now() - $2 * interval '1 day'`, [userId, this.retentionDays]);
    const vocabulary = await this.db.query('SELECT count(*)::int AS total FROM vocabulary_items WHERE user_id = $1', [userId]);
    return { turns: Number(result.rows[0]?.turns ?? 0), corrections: Number(result.rows[0]?.corrections ?? 0), vocabulary: Number(vocabulary.rows[0]?.total ?? 0) };
  }

  async recordAiAttempt(event: AiAttempt): Promise<void> {
    await this.db.query(`INSERT INTO ai_metrics_hourly(bucket, provider, feature, outcome, status_code, requests, duration_ms, input_tokens, output_tokens)
      VALUES (date_trunc('hour', now()), $1, $2, $3, $4, 1, $5, $6, $7)
      ON CONFLICT (bucket, provider, feature, outcome, status_code) DO UPDATE SET
        requests = ai_metrics_hourly.requests + 1,
        duration_ms = ai_metrics_hourly.duration_ms + EXCLUDED.duration_ms,
        input_tokens = ai_metrics_hourly.input_tokens + EXCLUDED.input_tokens,
        output_tokens = ai_metrics_hourly.output_tokens + EXCLUDED.output_tokens`,
    [event.provider, event.feature, event.outcome, event.statusCode, event.durationMs, event.usage.inputTokens, event.usage.outputTokens]);
  }

  async providerDayUsage(provider: ProviderName): Promise<{ requests: number; inputTokens: number; outputTokens: number }> {
    const result = await this.db.query(`SELECT coalesce(sum(requests), 0)::bigint AS requests,
      coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
      coalesce(sum(output_tokens), 0)::bigint AS output_tokens
      FROM ai_metrics_hourly
      WHERE provider = $1 AND bucket >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [provider]);
    return {
      requests: Number(result.rows[0]?.requests ?? 0),
      inputTokens: Number(result.rows[0]?.input_tokens ?? 0),
      outputTokens: Number(result.rows[0]?.output_tokens ?? 0),
    };
  }

  async operationsStats(): Promise<OperationsStats> {
    const [users, activity, vocabulary, providers] = await Promise.all([
      this.db.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS new_24h,
        count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_7d
        FROM app_users`),
      this.db.query(`SELECT
        count(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS active_24h,
        count(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '7 days')::int AS active_7d,
        count(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '30 days')::int AS active_30d,
        count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS turns_24h,
        count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS turns_7d,
        (SELECT count(*)::int FROM (SELECT user_id FROM turns WHERE created_at >= now() - interval '7 days' GROUP BY user_id HAVING count(*) >= 3) engaged_users) AS engaged_7d,
        (SELECT count(*)::int FROM (SELECT user_id FROM turns WHERE created_at >= now() - interval '7 days' GROUP BY user_id HAVING count(DISTINCT (created_at AT TIME ZONE 'UTC')::date) >= 2) returning_users) AS returning_7d
        FROM turns`),
      this.db.query(`SELECT count(*)::int AS items, count(DISTINCT user_id)::int AS users FROM vocabulary_items`),
      this.db.query(`SELECT provider,
        coalesce(sum(requests), 0)::bigint AS attempts,
        coalesce(sum(requests) FILTER (WHERE outcome = 'failure'), 0)::bigint AS failures,
        CASE WHEN sum(requests) > 0 THEN round(sum(duration_ms)::numeric / sum(requests))::bigint ELSE 0 END AS average_ms,
        coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
        coalesce(sum(output_tokens), 0)::bigint AS output_tokens
        FROM ai_metrics_hourly WHERE bucket >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        GROUP BY provider ORDER BY attempts DESC`),
    ]);
    const userRow = users.rows[0];
    const activityRow = activity.rows[0];
    const vocabularyRow = vocabulary.rows[0];
    return {
      users: { total: Number(userRow?.total ?? 0), new24h: Number(userRow?.new_24h ?? 0), new7d: Number(userRow?.new_7d ?? 0) },
      activity: {
        active24h: Number(activityRow?.active_24h ?? 0), active7d: Number(activityRow?.active_7d ?? 0), active30d: Number(activityRow?.active_30d ?? 0),
        turns24h: Number(activityRow?.turns_24h ?? 0), turns7d: Number(activityRow?.turns_7d ?? 0),
        engaged7d: Number(activityRow?.engaged_7d ?? 0), returning7d: Number(activityRow?.returning_7d ?? 0),
      },
      vocabulary: { users: Number(vocabularyRow?.users ?? 0), items: Number(vocabularyRow?.items ?? 0) },
      providersToday: providers.rows.map(row => ({
        provider: String(row.provider), attempts: Number(row.attempts), failures: Number(row.failures), averageMs: Number(row.average_ms),
        inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      })),
    };
  }

  async adminUsers(page: number, pageSize = 8): Promise<{ items: AdminUserRecord[]; total: number; pages: number; page: number }> {
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize) || page < 1 || pageSize < 1 || pageSize > 20) throw new Error('Invalid admin pagination');
    const count = await this.db.query('SELECT count(*)::int AS total FROM app_users');
    const total = Number(count.rows[0]?.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(page, pages);
    const result = await this.db.query(`SELECT u.id, u.settings, u.created_at, u.consented_at, u.consent_version, u.onboarding_completed,
      (SELECT count(*)::int FROM turns t WHERE t.user_id = u.id) AS turns,
      (SELECT count(*)::int FROM vocabulary_items v WHERE v.user_id = u.id) AS vocabulary,
      coalesce((SELECT max(t.created_at) FROM turns t WHERE t.user_id = u.id), u.created_at) AS last_active
      FROM app_users u ORDER BY last_active DESC, u.id DESC LIMIT $1 OFFSET $2`, [pageSize, (normalizedPage - 1) * pageSize]);
    return { items: result.rows.map(adminUserRecord), total, pages, page: normalizedPage };
  }

  async adminUser(userId: number): Promise<AdminUserRecord | null> {
    const result = await this.db.query(`SELECT u.id, u.settings, u.created_at, u.consented_at, u.consent_version, u.onboarding_completed,
      (SELECT count(*)::int FROM turns t WHERE t.user_id = u.id) AS turns,
      (SELECT count(*)::int FROM vocabulary_items v WHERE v.user_id = u.id) AS vocabulary,
      coalesce((SELECT max(t.created_at) FROM turns t WHERE t.user_id = u.id), u.created_at) AS last_active
      FROM app_users u WHERE u.id = $1`, [userId]);
    return result.rows[0] ? adminUserRecord(result.rows[0]) : null;
  }

  async adminRecentTurns(userId: number, limit = 5): Promise<AdminTurn[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid admin history limit');
    const result = await this.db.query(`SELECT user_text, answer, provider, created_at FROM turns
      WHERE user_id = $1 ORDER BY id DESC LIMIT $2`, [userId, limit]);
    return result.rows.reverse().map(row => {
      const answer = answerSchema.parse(row.answer);
      return { userText: String(row.user_text), reply: answer.reply, corrections: answer.corrections.length,
        provider: String(row.provider), createdAt: isoTime(row.created_at) };
    });
  }

  async adminVocabulary(userId: number, limit = 20): Promise<{ items: VocabularyItem[]; total: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid admin vocabulary limit');
    const [count, result] = await Promise.all([
      this.db.query('SELECT count(*)::int AS total FROM vocabulary_items WHERE user_id = $1', [userId]),
      this.db.query(`SELECT id, term, translation FROM vocabulary_items
        WHERE user_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2`, [userId, limit]),
    ]);
    return { items: result.rows.map(vocabularyItem), total: Number(count.rows[0]?.total ?? 0) };
  }
}

function normalizeSpaces(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function vocabularyItem(row: Record<string, unknown> | undefined): VocabularyItem {
  if (!row) throw new Error('Vocabulary item was not returned');
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid vocabulary item ID');
  return { id, term: String(row.term), translation: String(row.translation) };
}

function adminUserRecord(row: Record<string, unknown>): AdminUserRecord {
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid admin user ID');
  return {
    id,
    settings: settingsSchema.parse(row.settings),
    createdAt: isoTime(row.created_at),
    consentedAt: row.consented_at == null ? null : isoTime(row.consented_at),
    consentVersion: row.consent_version == null ? null : String(row.consent_version),
    onboardingCompleted: row.onboarding_completed === true,
    turns: Number(row.turns ?? 0),
    vocabulary: Number(row.vocabulary ?? 0),
    lastActive: isoTime(row.last_active),
  };
}

function isoTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  return date.toISOString();
}

import 'dotenv/config';
import { z } from 'zod';
import { correctionsSchema, languageSchema, levelSchema, voiceSchema } from './domain.js';

const integer = (fallback: number, min: number, max: number) => z.preprocess(
  value => value === undefined || value === '' ? fallback : value,
  z.coerce.number().int().min(min).max(max),
);
const envSchema = z.object({
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'Invalid Telegram bot token'),
  DATABASE_URL: z.string().url().refine(v => /^postgres(?:ql)?:\/\//.test(v), 'Expected a PostgreSQL URL'),
  PUBLIC_BOT: z.enum(['true', 'false']).default('true'),
  ALLOWED_USER_IDS: z.string().default('').refine(v => !v.trim() || v.split(',').every(id => /^\d+$/.test(id.trim()) && Number.isSafeInteger(Number(id)) && Number(id) > 0), 'Expected comma-separated Telegram user IDs'),
  GROQ_API_KEY: z.string().trim().default(''),
  GEMINI_API_KEY: z.string().trim().default(''),
  OPENROUTER_API_KEY: z.string().trim().default(''),
  CLOUDFLARE_API_TOKEN: z.string().trim().default(''),
  CLOUDFLARE_ACCOUNT_ID: z.string().default('').refine(v => !v || /^[a-f0-9]{32}$/i.test(v), 'Expected Cloudflare account ID'),
  CLOUDFLARE_CHAT_MODEL: z.string().default('@cf/qwen/qwen3-30b-a3b-fp8'),
  AI_PROVIDER_ORDER: z.string().default('groq,cloudflare,gemini,openrouter').transform(v => v.split(',').map(s => s.trim())).pipe(z.array(z.enum(['groq', 'cloudflare', 'gemini', 'openrouter'])).min(1)).refine(v => new Set(v).size === v.length, 'Duplicate providers'),
  GROQ_CHAT_MODEL: z.string().default('openai/gpt-oss-20b'),
  GEMINI_CHAT_MODEL: z.string().default('gemini-3.1-flash-lite'),
  OPENROUTER_CHAT_MODEL: z.string().default('openrouter/free').refine(v => v === 'openrouter/free' || v.endsWith(':free'), 'Only free OpenRouter models are allowed'),
  GROQ_STT_MODEL: z.string().default('whisper-large-v3-turbo'),
  GROQ_TTS_MODEL: z.string().default('canopylabs/orpheus-v1-english'),
  GROQ_TTS_VOICE: z.string().default('hannah'),
  LOCAL_TTS_FALLBACK: z.enum(['true', 'false']).default('true'),
  FFMPEG_PATH: z.string().default(''),
  DEFAULT_LEVEL: levelSchema.default('B1'),
  DEFAULT_EXPLANATION_LANGUAGE: languageSchema.default('ru'),
  DEFAULT_CORRECTIONS: correctionsSchema.default('detailed'),
  DEFAULT_VOICE_MODE: voiceSchema.default('auto'),
  MAX_VOICE_SECONDS: integer(120, 1, 600),
  MAX_AUDIO_BYTES: integer(10 * 1024 * 1024, 1024, 19 * 1024 * 1024),
  MAX_TEXT_CHARS: integer(4000, 100, 8000),
  HISTORY_TURNS: integer(8, 1, 30),
  HISTORY_MAX_CHARS: integer(6000, 1000, 30000),
  VOCABULARY_LIMIT: integer(1000, 1, 10000),
  RETENTION_DAYS: integer(30, 1, 365),
  DAILY_REQUEST_LIMIT: integer(100, 1, 10000),
  REQUEST_COOLDOWN_SECONDS: integer(4, 0, 3600),
  PROVIDER_TIMEOUT_MS: integer(30000, 1000, 60000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});
export type Config = z.infer<typeof envSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const normalized = { ...env };
  // Support the user's existing .env without copying or exposing credentials.
  for (const prefix of ['LLM', 'LLM_FALLBACK']) {
    const provider = env[`${prefix}_PROVIDER_NAME`]?.trim().toLowerCase();
    if (provider === 'groq') {
      normalized.GROQ_API_KEY ||= env[`${prefix}_API_KEY`];
      normalized.GROQ_CHAT_MODEL ||= env[`${prefix}_MODEL`];
    } else if (provider === 'cloudflare') {
      normalized.CLOUDFLARE_API_TOKEN ||= env[`${prefix}_API_KEY`];
      normalized.CLOUDFLARE_CHAT_MODEL ||= env[`${prefix}_MODEL`];
      try {
        const url = new URL(env[`${prefix}_API_URL`] ?? '');
        if (url.protocol === 'https:' && url.hostname === 'api.cloudflare.com') {
          normalized.CLOUDFLARE_ACCOUNT_ID ||= url.pathname.match(/\/accounts\/([a-f0-9]{32})(?:\/|$)/i)?.[1];
        }
      } catch { /* Validation below reports missing configuration without secrets. */ }
    }
  }
  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    // Do not include offending values: they may contain keys or DB passwords.
    throw new Error(`Invalid configuration: ${[...new Set(parsed.error.issues.map(i => i.path.join('.')))].join(', ')}. See .env.example.`);
  }
  const c = parsed.data;
  if (c.CLOUDFLARE_API_TOKEN && !c.CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID is required for the Cloudflare key.');
  const keys = { groq: c.GROQ_API_KEY, cloudflare: c.CLOUDFLARE_API_TOKEN, gemini: c.GEMINI_API_KEY, openrouter: c.OPENROUTER_API_KEY };
  if (!c.AI_PROVIDER_ORDER.some(name => keys[name])) throw new Error('Add at least one AI API key from AI_PROVIDER_ORDER to .env.');
  return c;
}

export function defaults(c: Config) {
  return { level: c.DEFAULT_LEVEL, explanationLanguage: c.DEFAULT_EXPLANATION_LANGUAGE, corrections: c.DEFAULT_CORRECTIONS, voiceMode: c.DEFAULT_VOICE_MODE };
}

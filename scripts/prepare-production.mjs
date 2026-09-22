import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const appKeys = `BOT_TOKEN PUBLIC_BOT ALLOWED_USER_IDS ADMIN_TELEGRAM_IDS ALERTS_ENABLED ALERT_TRANSIENT_FAILURE_THRESHOLD ALERT_COOLDOWN_MINUTES ALERT_BUDGET_PERCENT HEALTHCHECK_PING_URL HEALTHCHECK_INTERVAL_SECONDS GROQ_DAILY_TOKEN_BUDGET CLOUDFLARE_DAILY_NEURON_BUDGET CLOUDFLARE_INPUT_NEURONS_PER_MILLION CLOUDFLARE_OUTPUT_NEURONS_PER_MILLION OPENROUTER_DAILY_REQUEST_BUDGET GROQ_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_CHAT_MODEL AI_PROVIDER_ORDER GROQ_CHAT_MODEL GEMINI_CHAT_MODEL OPENROUTER_CHAT_MODEL GROQ_STT_MODEL GROQ_TTS_MODEL GROQ_TTS_VOICE LOCAL_TTS_FALLBACK FFMPEG_PATH DEFAULT_LEVEL DEFAULT_EXPLANATION_LANGUAGE DEFAULT_CORRECTIONS DEFAULT_VOICE_MODE MAX_VOICE_SECONDS MAX_AUDIO_BYTES MAX_TEXT_CHARS HISTORY_TURNS HISTORY_MAX_CHARS VOCABULARY_LIMIT RETENTION_DAYS DAILY_REQUEST_LIMIT GLOBAL_DAILY_REQUEST_LIMIT GLOBAL_MINUTE_REQUEST_LIMIT UPDATE_CONCURRENCY REQUEST_COOLDOWN_SECONDS PROVIDER_TIMEOUT_MS LOG_LEVEL`.split(' ');

appKeys.push('BACKUP_STATUS_DIR');

export function runtimeValues(source, securityKey) {
  const env = { ...source };
  for (const prefix of ['LLM', 'LLM_FALLBACK']) {
    const name = env[`${prefix}_PROVIDER_NAME`]?.trim().toLowerCase();
    if (name === 'groq') {
      env.GROQ_API_KEY ||= env[`${prefix}_API_KEY`];
      env.GROQ_CHAT_MODEL ||= env[`${prefix}_MODEL`];
    } else if (name === 'cloudflare') {
      env.CLOUDFLARE_API_TOKEN ||= env[`${prefix}_API_KEY`];
      env.CLOUDFLARE_CHAT_MODEL ||= env[`${prefix}_MODEL`];
      try {
        const url = new URL(env[`${prefix}_API_URL`]);
        if (url.protocol === 'https:' && url.hostname === 'api.cloudflare.com') env.CLOUDFLARE_ACCOUNT_ID ||= url.pathname.match(/\/accounts\/([a-f0-9]{32})(?:\/|$)/i)?.[1];
      } catch { /* Startup validation reports configuration keys, never values. */ }
    }
  }
  const password = env.POSTGRES_PASSWORD;
  if (!password || password.length < 24 || /^(english_local_only|password|changeme)/i.test(password)) throw Error('POSTGRES_PASSWORD must be explicitly set to a strong value (24+ characters); no default is allowed.');
  if (!securityKey || securityKey.length < 32) throw Error('SECURITY_HMAC_KEY must have 32+ characters.');
  const values = Object.fromEntries(appKeys.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  values.DATABASE_URL = `postgresql://english:${encodeURIComponent(password)}@db:5432/english`;
  values.SECURITY_HMAC_KEY = securityKey;
  values.BACKUP_STATUS_DIR = '/run/backup-status';
  if (Object.values(values).some(value => /[\r\n\0]/.test(value))) throw Error('Runtime environment values must be single-line.');
  return values;
}

export function prepare(sourceFile = '.env', directory = 'deploy') {
  const source = parseEnv(readFileSync(sourceFile, 'utf8'));
  const keyFile = `${directory}/security_key`;
  const key = existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : source.SECURITY_HMAC_KEY || randomBytes(32).toString('hex');
  if (existsSync(keyFile) && source.SECURITY_HMAC_KEY && source.SECURITY_HMAC_KEY !== key) throw Error('SECURITY_HMAC_KEY differs from persisted key. Refusing to reset security counters.');
  const values = runtimeValues(source, key);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(`${directory}/backup-status`, { recursive: true, mode: 0o755 });
  for (const [name, value] of Object.entries({ security_key: key, postgres_password: source.POSTGRES_PASSWORD,
    'runtime.env': Object.entries(values).map(([k,v]) => `${k}=${v}`).join('\n') + '\n' })) {
    writeFileSync(`${directory}/${name}`, value, { mode: 0o600 });
    chmodSync(`${directory}/${name}`, 0o600);
  }
  console.log('Production configuration prepared; only application settings are included.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { prepare(process.argv[2], process.argv[3]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

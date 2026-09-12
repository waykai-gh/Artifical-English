import { pino } from 'pino';
export function createLogger(level = 'info') {
  // Application logs use only statuses and provider names, never prompts or error bodies.
  return pino({ level, redact: ['BOT_TOKEN', 'DATABASE_URL', '*.apiKey', '*.token', '*.authorization', 'err', 'error'] });
}

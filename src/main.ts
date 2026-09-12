import { run } from '@grammyjs/runner';
import { readConfig, defaults } from './config.js';
import { createProviders } from './ai/providers.js';
import { AiRouter } from './ai/router.js';
import { createBot } from './bot.js';
import { createPool, migrate, Store } from './storage.js';
import { Speech } from './speech.js';
import { createLogger } from './log.js';
import { configureTelegramMenu } from './telegram-setup.js';
import { acquirePollingLock, RuntimeError, runtimeFailure, startRuntimeControl } from './runtime-health.js';

let stage = 'configuration';

async function main() {
  const c = readConfig();
  const logger = createLogger(c.LOG_LEVEL);
  const pool = createPool(c.DATABASE_URL);
  pool.on('error', () => logger.error('PostgreSQL connection error'));
  let releaseLock: (() => void) | undefined;
  let stopRunner: (() => void) | undefined;
  let lockLost = false;
  try {
    stage = 'database migration';
    await migrate(pool);
    const store = new Store(pool, defaults(c), c.HISTORY_TURNS, c.RETENTION_DAYS, c.HISTORY_MAX_CHARS);
    await store.cleanup();
    const providers = createProviders(c);
    const bot = createBot(c, { store, ai: new AiRouter(providers, logger), speech: new Speech(c), logger });
    stage = 'Telegram initialization';
    await bot.init();
    // Never silently replace another deployment's webhook or discard queued messages.
    if ((await bot.api.getWebhookInfo()).url) throw new RuntimeError('Active Telegram webhook exists. Remove it before starting the polling bot.');
    stage = 'polling lock';
    releaseLock = await acquirePollingLock(pool, bot.botInfo.id, () => {
      lockLost = true;
      logger.error('Polling lock connection lost; stopping this instance');
      stopRunner?.();
    });
    stage = 'Telegram menu setup';
    const users = await pool.query<{ id: string }>('SELECT id FROM app_users ORDER BY id');
    await configureTelegramMenu(bot.api, users.rows.map(user => Number(user.id)));
    if (lockLost) throw new RuntimeError('PostgreSQL polling lock was lost during startup.');
    stage = 'polling';
    const runner = run(bot, {
      runner: { fetch: { allowed_updates: ['message', 'callback_query'] }, silent: true },
      sink: { concurrency: 8 },
    });
    const cleanupTimer = setInterval(() => { void store.cleanup().catch(() => logger.error('Retention cleanup failed')); }, 60 * 60 * 1000);
    cleanupTimer.unref();
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (stopping) return;
      logger.info('Stopping polling; waiting for active requests to finish');
      stopping = runner.stop();
      void stopping?.catch(() => logger.error('Polling shutdown failed'));
    };
    stopRunner = stop;
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let closeControl: (() => Promise<void>) | undefined;
    // Capture task before installing control: stop() clears runner.task().
    const task = runner.task();
    try {
      if (process.platform === 'win32') closeControl = await startRuntimeControl(() => stopping ? 'stopping' : 'ready', stop);
      logger.info({ username: bot.botInfo.username, providers: providers.map(p => p.name) }, 'English tutor bot started');
      await task;
      if (lockLost) throw new RuntimeError('PostgreSQL polling lock was lost. Restart after restoring the database connection.');
    } finally {
      clearInterval(cleanupTimer);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      stop();
      await stopping;
      await closeControl?.();
      stopRunner = undefined;
    }
  } finally {
    releaseLock?.();
    await pool.end();
  }
}

main().catch(error => {
  // Some upstream errors embed API tokens in request URLs; diagnose via the safe doctor.
  process.stderr.write(`${runtimeFailure(error, stage)}\n`);
  process.exitCode = 1;
});

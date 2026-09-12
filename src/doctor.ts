import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Bot } from 'grammy';
import { readConfig, defaults } from './config.js';
import { createProviders } from './ai/providers.js';
import { ProviderError } from './ai/http.js';
import { createPool } from './storage.js';
import { ffmpegPath, Speech } from './speech.js';

async function main() {
  let c;
  try { c = readConfig(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid configuration');
    process.exitCode = 1;
    return;
  }
  const report = async (label: string, action: () => Promise<string>) => {
    try { console.log(`OK ${label}: ${await action()}`); }
    catch (error) {
      console.log(`FAIL ${label}${error instanceof ProviderError ? `: HTTP ${error.status || 'network/timeout'}` : ''}`);
      process.exitCode = 1;
    }
  };
  await report('PostgreSQL', async () => {
    const pool = createPool(c.DATABASE_URL);
    try { await pool.query('SELECT 1'); return 'connected'; } finally { await pool.end(); }
  });
  await report('Telegram', async () => {
    const bot = new Bot(c.BOT_TOKEN);
    const me = await bot.api.getMe();
    if ((await bot.api.getWebhookInfo()).url) throw new Error('Webhook active');
    const commands = await bot.api.getMyCommands({ scope: { type: 'default' } });
    const names = commands.map(command => command.command);
    if (names.join(',') !== 'start,menu') throw new Error(`command menu is ${names.join(',') || 'empty'}; expected start,menu`);
    return `@${me.username}; polling available; menu /start, /menu`;
  });
  await report('ffmpeg', async () => {
    await promisify(execFile)(ffmpegPath(c.FFMPEG_PATH), ['-version'], { timeout: 5000, windowsHide: true });
    return 'available';
  });
  console.log(`Access: ${c.PUBLIC_BOT === 'true' ? 'no Telegram ID restriction; private chats only' : 'allowlist'}`);
  console.log(`Configured chat services: ${createProviders(c).map(p => p.name).join(', ')}`);
  if (process.argv.includes('--live')) {
    for (const provider of createProviders(c)) {
      await report(`AI ${provider.name}`, async () => {
        const result = await provider.chat({ settings: defaults(c), history: [], text: 'Yesterday I go to the shop and buyed a coffee. How was your day?', fromVoice: false });
        return `valid tutor response; ${result.corrections.length} corrections`;
      });
    }
  } else console.log('Add -- --live to test configured AI keys with a short synthetic request.');
  if (process.argv.includes('--audio')) {
    await report('Voice round-trip', async () => {
      const speech = new Speech(c);
      const voice = await speech.speak('Hello! What did you do today?');
      const transcript = await speech.transcribe(voice, 'audio/ogg', 'test.ogg');
      return `OGG generated (${voice.length} bytes), speech recognized (${transcript.length} characters)`;
    });
  }
}
main().catch(() => { console.error('Diagnostic failed. No secrets were logged.'); process.exitCode = 1; });

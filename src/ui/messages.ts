import { Context, GrammyError, type InlineKeyboard } from 'grammy';
import { splitText } from '../format.js';
import type { Screen } from './screens.js';

export async function showScreen(ctx: Context, screen: Screen): Promise<void> {
  const options = { parse_mode: 'HTML' as const, reply_markup: screen.keyboard, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery?.message && ctx.callbackQuery.message.date !== 0) {
    try {
      await ctx.editMessageText(screen.text, options);
      return;
    } catch (error) {
      if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
      if (error.description.includes('message is not modified')) return;
      if (!/message (?:to edit not found|can't be edited)|MESSAGE_ID_INVALID/i.test(error.description)) throw error;
    }
  }
  await ctx.reply(screen.text, options);
}

export async function replyLong(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const chunks = splitText(text);
  for (const [index, chunk] of chunks.entries()) {
    await ctx.reply(chunk, {
      link_preview_options: { is_disabled: true },
      ...(index === chunks.length - 1 && keyboard ? { reply_markup: keyboard } : {}),
    });
  }
}

export async function withTyping<T>(ctx: Context, work: () => Promise<T>): Promise<T> {
  const send = () => ctx.replyWithChatAction('typing').catch(() => undefined);
  await send();
  const timer = setInterval(() => { void send(); }, 4000);
  timer.unref();
  try { return await work(); } finally { clearInterval(timer); }
}

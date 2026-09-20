import { Bot, Context, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import { sequentialize } from '@grammyjs/runner';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { correctionsSchema, guardTutorInput, languageSchema, levelSchema, UserError, voiceSchema, type Settings } from './domain.js';
import { formatAnswer, formatVocabularyUsage, splitText } from './format.js';
import { requestBytes } from './ai/http.js';
import type { AiRouter } from './ai/router.js';
import type { AdminTurn, AdminUserRecord, OperationsStats, Store, VocabularyItem } from './storage.js';
import type { SpeechService } from './speech.js';
import { createPending, type PendingAction } from './ui-state.js';
import { repairPrivateChatMenu, publicCommands } from './telegram-setup.js';
import type { BotDependencies } from './dependencies.js';
import { consentDeclinedScreen, consentScreen, dataScreen, dictionaryScreen, guideScreen, levelOnboardingScreen, mainMenuScreen, menuKeyboard, settingsChoiceScreen, settingsScreen, topicsScreen, vocabularyScreen, welcomeScreen, confirmScreen, type Screen, type SettingsSection } from './ui/screens.js';
import { showScreen } from './ui/messages.js';

export const commands = publicCommands;
export const CONSENT_VERSION = '2026-09-20.2';

export function operationsText(stats: OperationsStats, c: Config): string {
  const providerLines = stats.providersToday.length
    ? stats.providersToday.map(provider => {
      const success = provider.attempts ? Math.round((provider.attempts - provider.failures) / provider.attempts * 100) : 0;
      const tokens = provider.inputTokens + provider.outputTokens;
      const cloudflareUnits = provider.provider === 'cloudflare' && tokens
        ? Math.ceil(provider.inputTokens * c.CLOUDFLARE_INPUT_NEURONS_PER_MILLION / 1_000_000 + provider.outputTokens * c.CLOUDFLARE_OUTPUT_NEURONS_PER_MILLION / 1_000_000)
        : 0;
      const budgetPercent = provider.provider === 'groq' && c.GROQ_DAILY_TOKEN_BUDGET > 0
        ? Math.floor(tokens / c.GROQ_DAILY_TOKEN_BUDGET * 100)
        : provider.provider === 'cloudflare' && c.CLOUDFLARE_DAILY_NEURON_BUDGET > 0
          ? Math.floor(cloudflareUnits / c.CLOUDFLARE_DAILY_NEURON_BUDGET * 100)
          : provider.provider === 'openrouter' && c.OPENROUTER_DAILY_REQUEST_BUDGET > 0
            ? Math.floor(provider.attempts / c.OPENROUTER_DAILY_REQUEST_BUDGET * 100) : 0;
      return `• ${provider.provider}: ${provider.attempts} запросов · ${success}% успешно · ${provider.averageMs} мс${tokens ? ` · ${tokens.toLocaleString('ru-RU')} токенов` : ''}${cloudflareUnits ? ` · ~${cloudflareUnits.toLocaleString('ru-RU')} нейронов` : ''}${budgetPercent ? ` · ${budgetPercent}% бюджета` : ''}`;
    }).join('\n')
    : '• Сегодня запросов ещё нет';
  const alerts = c.ALERTS_ENABLED === 'true' && c.ADMIN_TELEGRAM_IDS.trim() ? 'включены' : 'выключены';
  return `📊 Состояние бота\n\nПользователи\nВсего: ${stats.users.total}\nНовые: ${stats.users.new24h} за 24 ч · ${stats.users.new7d} за 7 дней\nАктивные: ${stats.activity.active24h} / ${stats.activity.active7d} / ${stats.activity.active30d} за 1 / 7 / 30 дней\nВовлечённые (3+ реплики за 7 дней): ${stats.activity.engaged7d}\nВернулись минимум в 2 разных дня: ${stats.activity.returning7d}\n\nИспользование\nУспешных реплик: ${stats.activity.turns24h} за 24 ч · ${stats.activity.turns7d} за 7 дней\nСловарь: ${stats.vocabulary.items} записей у ${stats.vocabulary.users} пользователей\n\nAI сегодня (UTC)\n${providerLines}\n\nКонтекст\nДо ${c.HISTORY_TURNS} последних пар · максимум ${c.HISTORY_MAX_CHARS.toLocaleString('ru-RU')} символов · хранение ${c.RETENTION_DAYS} дней\n\nАлерты: ${alerts}`;
}

export function settingsText(s: Settings) {
  return `Уровень: ${s.level}\nРазбор ошибок: ${s.corrections}\nЯзык объяснений: ${s.explanationLanguage}\nОзвучка: ${s.voiceMode}`;
}

function privacyText(c: Config): string {
  return `<b>Данные и приватность</b>

• Telegram ID и настройки.
• Тексты, расшифровки голоса и ответы — ${c.RETENTION_DAYS} дней.
• Словарь — пока ты не удалишь записи или все данные.

Тексты и расшифровки передаются AI-сервису для ответа; Telegram ID туда не передаётся. В контекст попадают до ${c.HISTORY_TURNS} последних пар сообщений. Аудиофайлы в базе не хранятся.
Владелец бота может просматривать сохранённые настройки, словарь и последние реплики для поддержки. Доступ есть только у владельца.

/forget удаляет данные из базы бота, но не копии Telegram, резервные копии или уже обработанные данные внешних сервисов.

Продукт создан с помощью ИИ; ответы могут содержать ошибки.`;
}

function adminDashboardScreen(stats: OperationsStats, c: Config): Screen {
  return { text: operationsText(stats, c), keyboard: new InlineKeyboard().text('👥 Пользователи', 'admin:users:1') };
}

function adminUsersScreen(result: { items: AdminUserRecord[]; total: number; pages: number; page: number }): Screen {
  const keyboard = new InlineKeyboard();
  for (const user of result.items) keyboard.text(`${user.id} · ${user.settings.level} · ${user.turns} репл.`, `admin:user:${user.id}:${result.page}`).row();
  if (result.pages > 1) {
    if (result.page > 1) keyboard.text('‹', `admin:users:${result.page - 1}`);
    keyboard.text(`${result.page}/${result.pages}`, `admin:users:${result.page}`);
    if (result.page < result.pages) keyboard.text('›', `admin:users:${result.page + 1}`);
    keyboard.row();
  }
  keyboard.text('‹ Статистика', 'admin:dashboard');
  const rows = result.items.length ? result.items.map(user => `• <code>${user.id}</code> · ${user.settings.level} · активен ${formatAdminTime(user.lastActive)}`).join('\n') : 'Пользователей пока нет.';
  return { text: `<b>Пользователи · ${result.total}</b>\n\n${rows}\n\nМожно также ввести /admin Telegram_ID.`, keyboard };
}

function adminUserScreen(user: AdminUserRecord, page: number): Screen {
  const consent = user.consentedAt ? `${formatAdminTime(user.consentedAt)} · ${escapeHtmlForBot(user.consentVersion ?? 'версия не указана')}` : 'не принято';
  return {
    text: `<b>Пользователь <code>${user.id}</code></b>\n\nСоздан: ${formatAdminTime(user.createdAt)}\nПоследняя активность: ${formatAdminTime(user.lastActive)}\nСогласие: ${consent}\nОнбординг: ${user.onboardingCompleted ? 'пройден' : 'не пройден'}\n\nУровень: ${user.settings.level}\nИсправления: ${user.settings.corrections}\nЯзык объяснений: ${user.settings.explanationLanguage}\nГолос: ${user.settings.voiceMode}\n\nРеплики: ${user.turns}\nСловарь: ${user.vocabulary}`,
    keyboard: new InlineKeyboard().text('💬 Последние реплики', `admin:history:${user.id}:${page}`).row()
      .text('📚 Словарь', `admin:words:${user.id}:${page}`).row().text('‹ Пользователи', `admin:users:${page}`),
  };
}

function adminHistoryScreen(userId: number, turns: AdminTurn[], page: number): Screen {
  const rows = turns.length ? turns.map(turn => `<b>${formatAdminTime(turn.createdAt)}</b>\nПользователь: ${escapeHtmlForBot(shortAdminText(turn.userText))}\nEllie: ${escapeHtmlForBot(shortAdminText(turn.reply))}\n${escapeHtmlForBot(turn.provider)} · исправлений: ${turn.corrections}`).join('\n\n') : 'Сохранённых реплик нет.';
  return { text: `<b>Последние реплики · <code>${userId}</code></b>\n\n${rows}`, keyboard: new InlineKeyboard().text('‹ К пользователю', `admin:user:${userId}:${page}`) };
}

function adminVocabularyScreen(userId: number, data: { items: VocabularyItem[]; total: number }, page: number): Screen {
  const rows = data.items.length ? data.items.map(item => `• ${escapeHtmlForBot(shortAdminText(item.term, 70))} — ${escapeHtmlForBot(shortAdminText(item.translation, 120))}`).join('\n') : 'Словарь пуст.';
  return { text: `<b>Словарь · <code>${userId}</code> · ${data.total}</b>\n\n${rows}${data.total > data.items.length ? `\n\nПоказаны последние ${data.items.length}.` : ''}`, keyboard: new InlineKeyboard().text('‹ К пользователю', `admin:user:${userId}:${page}`) };
}

function formatAdminTime(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

function shortAdminText(value: string, limit = 260): string {
  const chars = Array.from(value);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : value;
}

export type { BotDependencies } from './dependencies.js';

export function createBot(c: Config, deps: BotDependencies): Bot {
  const { store, ai, speech, logger, operations } = deps;
  const bot = new Bot(c.BOT_TOKEN);
  const allowed = new Set(c.ALLOWED_USER_IDS.split(',').map(s => s.trim()).filter(Boolean));
  const admins = new Set(c.ADMIN_TELEGRAM_IDS.split(',').map(s => s.trim()).filter(Boolean));
  for (const id of admins) allowed.add(id);

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return;
    await next();
  });
  bot.command('id', ctx => ctx.reply(`Твой Telegram ID: ${ctx.from!.id}`));
  bot.use(async (ctx, next) => {
    if (c.PUBLIC_BOT !== 'true' && !allowed.has(String(ctx.from!.id))) {
      await ctx.reply('Доступ ограничен. Узнать свой ID: /id. Владелец может добавить его в ALLOWED_USER_IDS.');
      return;
    }
    await next();
  });
  bot.use(sequentialize(ctx => String(ctx.from!.id)));
  bot.use(async (ctx, next) => {
    try { await next(); } catch (error) {
      logger.error({ kind: error instanceof UserError ? 'user_error' : 'update_error', telegramCode: error instanceof GrammyError ? error.error_code : undefined }, 'Update could not be completed');
      if (!(error instanceof UserError)) await operations?.noteUpdateError();
      await ctx.reply(error instanceof UserError ? error.message : 'Не удалось завершить запрос. Попробуй ещё раз через минуту.').catch(() => undefined);
    }
  });

  bot.command('admin', async ctx => {
    if (!admins.has(String(ctx.from!.id))) { await ctx.reply('Команда недоступна.'); return; }
    const reference = ctx.match.trim();
    if (reference) {
      const userId = Number(reference);
      if (!/^\d+$/.test(reference) || !Number.isSafeInteger(userId) || userId < 1) { await ctx.reply('Формат: /admin Telegram_ID'); return; }
      const user = await store.adminUser(userId);
      if (!user) { await ctx.reply('Пользователь с таким Telegram ID не найден.'); return; }
      await showScreen(ctx, adminUserScreen(user, 1));
      return;
    }
    await showScreen(ctx, adminDashboardScreen(await store.operationsStats(), c));
  });

  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('admin:')) { await next(); return; }
    await ctx.answerCallbackQuery().catch(() => undefined);
    if (!admins.has(String(ctx.from!.id))) { await ctx.reply('Команда недоступна.'); return; }
    const [, action, arg, extra] = data.split(':');
    if (action === 'dashboard') { await showScreen(ctx, adminDashboardScreen(await store.operationsStats(), c)); return; }
    if (action === 'users') {
      const page = Number(arg ?? '1');
      if (!Number.isSafeInteger(page) || page < 1) return;
      await showScreen(ctx, adminUsersScreen(await store.adminUsers(page)));
      return;
    }
    const userId = Number(arg);
    const page = Number(extra ?? '1');
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(page) || page < 1) return;
    const user = await store.adminUser(userId);
    if (!user) { await showScreen(ctx, { text: 'Пользователь больше не найден.', keyboard: new InlineKeyboard().text('‹ Пользователи', `admin:users:${page}`) }); return; }
    if (action === 'user') { await showScreen(ctx, adminUserScreen(user, page)); return; }
    if (action === 'history') { await showScreen(ctx, adminHistoryScreen(userId, await store.adminRecentTurns(userId, 5), page)); return; }
    if (action === 'words') { await showScreen(ctx, adminVocabularyScreen(userId, await store.adminVocabulary(userId, 15), page)); }
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from!.id;
    const command = ctx.message?.text?.split(/\s/, 1)[0]?.toLowerCase();
    const callback = ctx.callbackQuery?.data ?? '';
    const publicBeforeConsent = command === '/start' || command === '/privacy' || command === '/forget'
      || callback.startsWith('ui:consent:') || callback.startsWith('ui:privacy:');
    if (publicBeforeConsent) { await next(); return; }
    if (!await store.hasConsent(userId, CONSENT_VERSION)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
      await showScreen(ctx, consentScreen());
      return;
    }
    if (!await store.onboardingCompleted(userId) && !callback.startsWith('ui:onboard:')) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
      await showScreen(ctx, levelOnboardingScreen());
      return;
    }
    await next();
  });

  bot.command('start', async ctx => {
    const userId = ctx.from!.id;
    if (!await store.hasConsent(userId, CONSENT_VERSION)) { await showScreen(ctx, consentScreen()); return; }
    if (!await store.onboardingCompleted(userId)) { await showScreen(ctx, levelOnboardingScreen()); return; }
    await store.setPending(userId, null);
    void repairPrivateChatMenu(bot.api, userId, ctx.from?.language_code).catch(() => undefined);
    const ui = await store.getUiState(userId);
    const settings = await store.settings(userId);
    await showScreen(ctx, welcomeScreen(ui.conversationCount > 0, settings.level));
  });
  bot.command('menu', async ctx => {
    await store.setPending(ctx.from!.id, null);
    const stats = await store.stats(ctx.from!.id);
    await showScreen(ctx, mainMenuScreen(stats));
  });
  // Kept as a backwards-compatible deep link, but deliberately hidden from Telegram's command tray.
  bot.command('help', async ctx => { await showScreen(ctx, guideScreen(speech.canTranscribe)); });
  bot.command('settings', async ctx => { await showScreen(ctx, settingsScreen(await store.settings(ctx.from!.id))); });
  bot.command('level', async ctx => {
    const value = levelSchema.safeParse(ctx.match.trim().toUpperCase());
    if (!value.success) { await ctx.reply('Выбери уровень: /level A0, A1, A2, B1, B2, C1 или C2.'); return; }
    await ctx.reply(settingsText(await store.updateSettings(ctx.from!.id, { level: value.data })));
  });
  bot.command('corrections', async ctx => {
    const value = correctionsSchema.safeParse(ctx.match.trim().toLowerCase());
    if (!value.success) { await ctx.reply('/corrections detailed — подробно\n/corrections gentle — до 3 основных ошибок\n/corrections off — без исправлений'); return; }
    await ctx.reply(settingsText(await store.updateSettings(ctx.from!.id, { corrections: value.data })));
  });
  bot.command('language', async ctx => {
    const value = languageSchema.safeParse(ctx.match.trim().toLowerCase());
    if (!value.success) { await ctx.reply('/language ru — русский\n/language en — английский'); return; }
    await ctx.reply(settingsText(await store.updateSettings(ctx.from!.id, { explanationLanguage: value.data })));
  });
  bot.command('voice', async ctx => {
    const value = voiceSchema.safeParse(ctx.match.trim().toLowerCase());
    if (!value.success) { await ctx.reply('/voice auto — голосом на голосовое\n/voice on — всегда озвучивать\n/voice off — только текст'); return; }
    if (value.data !== 'off' && !speech.canSpeak) { await ctx.reply('Озвучка требует ключ Groq или LOCAL_TTS_FALLBACK=true. Текстовый чат доступен.'); return; }
    await ctx.reply(settingsText(await store.updateSettings(ctx.from!.id, { voiceMode: value.data })));
  });
  bot.command(['save', 'addword'], async ctx => {
    const parsed = parseVocabularyEntry(ctx.match);
    if (!parsed) {
      await ctx.reply('Формат: /save слово или выражение | перевод\n\nПример: /save take off | взлетать, снимать');
      return;
    }
    const item = await store.saveVocabulary(ctx.from!.id, parsed.term, parsed.translation, c.VOCABULARY_LIMIT);
    if (!item) { await ctx.reply(`Словарь заполнен: максимум ${c.VOCABULARY_LIMIT} записей. Удали ненужную через /delword номер и повтори.`); return; }
    await ctx.reply(`✅ Сохранено: #${item.id}\n${item.term} — ${item.translation}\n\nРазбор употребления: /word ${item.id}\nВесь словарь: /words`);
  });
  bot.command(['words', 'vocab'], async ctx => {
    const rawPage = ctx.match.trim();
    const page = rawPage ? Number(rawPage) : 1;
    if (!Number.isSafeInteger(page) || page < 1) { await ctx.reply('Укажи номер страницы, например: /words 2'); return; }
    const result = await store.listVocabulary(ctx.from!.id, page);
    if (!result.total) { await ctx.reply('Словарь пока пуст. Добавь первую запись:\n/save take off | взлетать, снимать'); return; }
    const rows = result.items.map(item => `#${item.id}  ${item.term} — ${item.translation}`).join('\n');
    const navigation = result.pages > 1 ? `\n\nСтраница ${result.page}/${result.pages}. Другая страница: /words 2` : '';
    await replyLong(ctx, `📚 Мой словарь · ${result.total}\n\n${rows}${navigation}\n\nПодробный разбор: /word номер`);
  });
  bot.command(['word', 'explain'], async ctx => {
    const reference = ctx.match.trim();
    if (!reference) { await ctx.reply('Укажи номер или точное выражение из словаря. Например: /word 12 или /word take off'); return; }
    const item = await store.findVocabulary(ctx.from!.id, reference);
    if (!item) { await ctx.reply('Такой записи в словаре нет. Посмотреть сохранённые слова: /words'); return; }
    if (!await store.claimRequest(ctx.from!.id, c.DAILY_REQUEST_LIMIT, c.REQUEST_COOLDOWN_SECONDS)) {
      await ctx.reply(`Слишком частые запросы или достигнут лимит ${c.DAILY_REQUEST_LIMIT} обращений в день (UTC). Пауза между запросами — ${c.REQUEST_COOLDOWN_SECONDS} с.`);
      return;
    }
    await withTyping(ctx, async () => {
      const settings = await store.settings(ctx.from!.id);
      const result = await ai.explainVocabulary({ settings, term: item.term, translation: item.translation });
      await replyLong(ctx, formatVocabularyUsage(item, result.usage, settings));
      logger.info({ provider: result.provider, feature: 'vocabulary' }, 'Vocabulary usage explained');
    });
  });
  bot.command('delword', async ctx => {
    const raw = ctx.match.trim().replace(/^#/, '');
    const id = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id < 1) { await ctx.reply('Укажи номер записи. Например: /delword 12'); return; }
    await ctx.reply(await store.deleteVocabulary(ctx.from!.id, id)
      ? `Запись #${id} удалена из словаря.`
      : 'Запись не найдена. Посмотреть словарь: /words');
  });
  bot.command('reset', async ctx => {
    await store.clear(ctx.from!.id);
    const settings = await store.settings(ctx.from!.id);
    await showScreen(ctx, welcomeScreen(true, settings.level));
  });
  bot.command('forget', async ctx => { await store.forget(ctx.from!.id); await showScreen(ctx, consentScreen()); });
  bot.command('stats', async ctx => {
    const stats = await store.stats(ctx.from!.id);
    await ctx.reply(`За последние ${c.RETENTION_DAYS} дней с момента очистки:\nСообщений в практике: ${stats.turns}\nРазобрано ошибок: ${stats.corrections}\nСлов и выражений в словаре: ${stats.vocabulary}`);
  });
  bot.command('privacy', async ctx => {
    const hasConsent = await store.hasConsent(ctx.from!.id, CONSENT_VERSION);
    await showScreen(ctx, { text: privacyText(c), keyboard: new InlineKeyboard().text('‹ Назад', hasConsent ? 'ui:guide' : 'ui:consent:show') });
  });

  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => undefined);
    const userId = ctx.from!.id;
    const [scope, action, arg, extra] = data.split(':');
    if (scope !== 'ui') return;
    const clearPending = async () => { await store.setPending(userId, null); };

    if (action === 'consent') {
      if (arg === 'accept') {
        await store.acceptConsent(userId, CONSENT_VERSION);
        if (await store.onboardingCompleted(userId)) {
          const settings = await store.settings(userId);
          await showScreen(ctx, welcomeScreen((await store.getUiState(userId)).conversationCount > 0, settings.level));
        } else await showScreen(ctx, levelOnboardingScreen());
      } else if (arg === 'decline') {
        await store.forget(userId);
        await showScreen(ctx, consentDeclinedScreen());
      } else {
        await showScreen(ctx, consentScreen());
      }
      return;
    }
    if (action === 'onboard') {
      const parsed = levelSchema.safeParse(arg);
      if (!parsed.success || !await store.hasConsent(userId, CONSENT_VERSION)) { await showScreen(ctx, consentScreen()); return; }
      const settings = await store.completeOnboarding(userId, parsed.data);
      void repairPrivateChatMenu(bot.api, userId, ctx.from?.language_code).catch(() => undefined);
      await showScreen(ctx, welcomeScreen(false, settings.level));
      return;
    }

    if (action === 'menu') {
      await clearPending();
      await showScreen(ctx, mainMenuScreen(await store.stats(userId)));
      return;
    }
    if (action === 'chat') {
      await clearPending();
      const state = await store.getUiState(userId);
      const settings = await store.settings(userId);
      await showScreen(ctx, welcomeScreen(state.conversationCount > 0, settings.level));
      return;
    }
    if (action === 'guide') { await clearPending(); await showScreen(ctx, guideScreen(speech.canTranscribe)); return; }
    if (action === 'topics') {
      await clearPending();
      await showScreen(ctx, topicsScreen((await store.settings(userId)).level));
      return;
    }
    if (action === 'topic') {
      const level = (await store.settings(userId)).level;
      const questions: Record<string, string> = level === 'A0' ? {
        alphabet: 'Начнём с алфавита и звуков. Напиши, знаешь ли ты хоть несколько английских букв.',
        basics: '<b>Hello</b> — «привет» («хэлоу»). Напиши «готов», и мы разберём первое приветствие.',
        intro: 'Будем учиться представляться. Напиши своё имя по-русски.',
      } : {
        day: 'What did you do today? Tell me about one good or difficult moment.',
        food: 'What do you usually eat or drink when you want to feel good?',
        travel: 'Where would you like to travel, and what would you do there?',
      };
      const question = questions[arg ?? ''];
      if (!question) return;
      await ctx.editMessageText(level === 'A0' ? question : `Great, let’s talk about it.\n\n<b>${question}</b>`, { parse_mode: 'HTML', reply_markup: menuKeyboard() });
      return;
    }
    if (action === 'settings') {
      if (!arg) { await clearPending(); await showScreen(ctx, settingsScreen(await store.settings(userId))); return; }
      const section = arg as SettingsSection;
      if (!['level', 'corrections', 'language', 'voice'].includes(section)) return;
      await showScreen(ctx, settingsChoiceScreen(section, await store.settings(userId), speech.canSpeak));
      return;
    }
    if (action === 'set') {
      const section = arg as SettingsSection;
      const value = extra;
      if (section === 'level') {
        const parsed = levelSchema.safeParse(value);
        if (!parsed.success) return;
        await store.updateSettings(userId, { level: parsed.data });
      } else if (section === 'corrections') {
        const parsed = correctionsSchema.safeParse(value);
        if (!parsed.success) return;
        await store.updateSettings(userId, { corrections: parsed.data });
      } else if (section === 'language') {
        const parsed = languageSchema.safeParse(value);
        if (!parsed.success) return;
        await store.updateSettings(userId, { explanationLanguage: parsed.data });
      } else if (section === 'voice') {
        const parsed = voiceSchema.safeParse(value);
        if (!parsed.success || (parsed.data !== 'off' && !speech.canSpeak)) return;
        await store.updateSettings(userId, { voiceMode: parsed.data });
      } else return;
      await showScreen(ctx, settingsScreen(await store.settings(userId), 'Настройка обновлена.'));
      return;
    }
    if (action === 'data') { await clearPending(); await showScreen(ctx, dataScreen()); return; }
    if (action === 'privacy') {
      await showScreen(ctx, { text: privacyText(c), keyboard: new InlineKeyboard().text('‹ Назад', arg === 'consent' ? 'ui:consent:show' : 'ui:guide') });
      return;
    }
    if (action === 'words') {
      const page = Number(arg ?? '1');
      if (!Number.isSafeInteger(page) || page < 1) return;
      await clearPending();
      await showScreen(ctx, dictionaryScreen(await store.listVocabulary(userId, page)));
      return;
    }
    if (action === 'word') {
      const id = Number(arg);
      const page = Number(extra ?? '1');
      if (!Number.isSafeInteger(id) || id < 1) return;
      const item = await store.findVocabulary(userId, String(id));
      if (!item) { await showScreen(ctx, dictionaryScreen(await store.listVocabulary(userId, page))); return; }
      await showScreen(ctx, vocabularyScreen(item, page));
      return;
    }
    if (action === 'add' || action === 'edit') {
      const id = action === 'edit' ? Number(arg) : undefined;
      const item = id && Number.isSafeInteger(id) ? await store.findVocabulary(userId, String(id)) : null;
      const pending = item ? createPending('translation', item.term) : createPending('term');
      const prompt = item
        ? `Напиши новый перевод для <b>${item.term.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</b> одним сообщением.`
        : 'Напиши английское слово или выражение одним сообщением.';
      const sent = await ctx.reply(prompt, { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: item ? 'Новый перевод' : 'English word or phrase' } });
      await store.setPending(userId, { ...pending, promptMessageId: sent.message_id });
      return;
    }
    if (action === 'delete') {
      const id = Number(arg);
      const page = Number(extra ?? '1');
      if (!Number.isSafeInteger(id) || id < 1) return;
      const item = await store.findVocabulary(userId, String(id));
      if (!item) { await showScreen(ctx, dictionaryScreen(await store.listVocabulary(userId, page))); return; }
      const pending = createPending('confirm', 'deleteWord', id);
      await store.setPending(userId, pending);
      await showScreen(ctx, confirmScreen('deleteWord', pending.nonce, item.term));
      return;
    }
    if (action === 'explain') {
      const id = Number(arg);
      const page = Number(extra ?? '1');
      if (!Number.isSafeInteger(id) || id < 1) return;
      const item = await store.findVocabulary(userId, String(id));
      if (!item) { await showScreen(ctx, dictionaryScreen(await store.listVocabulary(userId, page))); return; }
      if (!await store.claimRequest(userId, c.DAILY_REQUEST_LIMIT, c.REQUEST_COOLDOWN_SECONDS)) {
        await ctx.reply(`Слишком частые запросы или достигнут лимит ${c.DAILY_REQUEST_LIMIT} обращений в день (UTC).`);
        return;
      }
      await withTyping(ctx, async () => {
        const settings = await store.settings(userId);
        const result = await ai.explainVocabulary({ settings, term: item.term, translation: item.translation });
        await replyLong(ctx, formatVocabularyUsage(item, result.usage, settings), new InlineKeyboard().text('‹ К словарю', 'ui:words:1'));
        logger.info({ provider: result.provider, feature: 'vocabulary' }, 'Vocabulary usage explained');
      });
      return;
    }
    if (action === 'reset' || action === 'forget') {
      const pending = createPending('confirm', action);
      await store.setPending(userId, pending);
      await showScreen(ctx, confirmScreen(action, pending.nonce));
      return;
    }
    if (action === 'cancel' || action === 'confirm') {
      const state = await store.getUiState(userId);
      const pending = state.pending;
      if (!pending || pending.step !== 'confirm' || pending.nonce !== arg) {
        await showScreen(ctx, mainMenuScreen(await store.stats(userId)));
        return;
      }
      if (action === 'cancel') {
        await store.setPending(userId, null, pending.nonce);
        await showScreen(ctx, pending.action === 'deleteWord' ? dictionaryScreen(await store.listVocabulary(userId, 1)) : mainMenuScreen(await store.stats(userId)));
        return;
      }
      if (!await store.setPending(userId, null, pending.nonce)) {
        await showScreen(ctx, mainMenuScreen(await store.stats(userId)));
        return;
      }
      if (pending.action === 'reset') {
        await store.clear(userId);
        await showScreen(ctx, welcomeScreen(true, (await store.settings(userId)).level));
      } else if (pending.action === 'forget') {
        await store.forget(userId);
        await showScreen(ctx, consentScreen());
      } else if (pending.itemId) {
        await store.deleteVocabulary(userId, pending.itemId);
        await showScreen(ctx, dictionaryScreen(await store.listVocabulary(userId, 1)));
      }
    }
  });

  bot.on('message', async ctx => {
    const message = ctx.message;
    const userId = ctx.from!.id;
    const uiState = await store.getUiState(userId);
    const pending = uiState.pending;
    if (message.text?.startsWith('/')) { await ctx.reply('Не знаю эту команду. Открой /menu — там все возможности бота.'); return; }
    const audio = message.voice ?? message.audio;
    if (!message.text && !audio) { await ctx.reply('Отправь текст, голосовое или аудиофайл.'); return; }
    if (pending?.step === 'term' && message.text) {
      const term = normalizeUiInput(message.text, 160);
      if (!term) { await ctx.reply('Нужно написать английское слово или выражение. Попробуй ещё раз.'); return; }
      const next = createPending('translation', term);
      const prompt = await ctx.reply(`Теперь напиши перевод для:\n<b>${escapeHtmlForBot(term)}</b>`, {
        parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Перевод' },
      });
      if (!await store.setPending(userId, { ...next, promptMessageId: prompt.message_id }, pending.nonce)) {
        await ctx.reply('Этот шаг уже истёк. Нажми «Добавить» в меню словаря ещё раз.');
      }
      return;
    }
    if (pending?.step === 'translation' && message.text) {
      const translation = normalizeUiInput(message.text, 400);
      if (!translation) { await ctx.reply('Нужно написать перевод одним сообщением. Попробуй ещё раз.'); return; }
      const item = await store.saveVocabulary(userId, pending.term, translation, c.VOCABULARY_LIMIT);
      await store.setPending(userId, null, pending.nonce);
      if (!item) { await ctx.reply(`Словарь заполнен: максимум ${c.VOCABULARY_LIMIT} записей. Удали ненужную запись через меню.`); return; }
      await showScreen(ctx, vocabularyScreen(item, 1, true));
      return;
    }
    if (pending?.step === 'confirm') await store.setPending(userId, null, pending.nonce);
    if (message.text && message.text.length > c.MAX_TEXT_CHARS) { await ctx.reply(`Сообщение слишком длинное: максимум ${c.MAX_TEXT_CHARS} символов.`); return; }
    if (audio && (audio.duration > c.MAX_VOICE_SECONDS || (audio.file_size ?? 0) > c.MAX_AUDIO_BYTES)) {
      await ctx.reply(`Отправь аудио до ${c.MAX_VOICE_SECONDS} секунд и до ${Math.floor(c.MAX_AUDIO_BYTES / 1024 / 1024)} МБ.`); return;
    }
    if (audio && !speech.canTranscribe) { await ctx.reply('Распознавание голоса требует ключ Groq или Gemini. Пока можно написать текстом.'); return; }
    const settings = await store.settings(userId);
    if (await store.hasTurn(userId, ctx.update.update_id)) return;
    if (!await store.claimRequest(userId, c.DAILY_REQUEST_LIMIT, c.REQUEST_COOLDOWN_SECONDS)) {
      await ctx.reply(`Слишком частые запросы или достигнут лимит ${c.DAILY_REQUEST_LIMIT} обращений в день (UTC). Пауза между запросами — ${c.REQUEST_COOLDOWN_SECONDS} с.`); return;
    }
    await withTyping(ctx, async () => {
      let text = message.text?.trim() ?? '';
      if (audio) {
        const file = await ctx.api.getFile(audio.file_id);
        if (!file.file_path || (file.file_size ?? 0) > c.MAX_AUDIO_BYTES) throw new UserError('Не удалось загрузить аудио или оно слишком большое.');
        const bytes = await requestBytes(fetch, `https://api.telegram.org/file/bot${c.BOT_TOKEN}/${file.file_path}`, {}, c.PROVIDER_TIMEOUT_MS, c.MAX_AUDIO_BYTES);
        const extension = message.voice ? 'ogg' : file.file_path.split('.').at(-1)?.toLowerCase();
        const mimeTypes: Record<string, string> = { ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm', aac: 'audio/aac' };
        if (!extension || !mimeTypes[extension]) throw new UserError('Неизвестный формат аудио. Отправь голосовое, MP3, WAV, M4A, OGG или FLAC.');
        text = await speech.transcribe(bytes, mimeTypes[extension]!, `recording.${extension}`);
        await replyLong(ctx, `🎧 Я услышала:\n${text}`);
      }
      if (!text) throw new UserError('Напиши сообщение или запиши голосовое с речью.');
      const input = { settings, history: await store.history(userId), text, fromVoice: Boolean(audio) };
      const guarded = guardTutorInput(input);
      const result = guarded ? { answer: guarded, provider: 'local-scope-guard' } : await ai.chat(input);
      await replyLong(ctx, formatAnswer(result.answer, settings, Boolean(audio)));
      // Save only after Telegram accepts the text. Telegram and PostgreSQL cannot commit atomically.
      await store.saveTurn(userId, ctx.update.update_id, text, result.answer, result.provider);
      if (result.provider !== 'local-scope-guard') {
        const conversationCount = await store.noteConversation(userId);
        if (conversationCount === 1 && await store.markTipSeen(userId, 'vocabulary')) {
          await ctx.reply('💡 Встретилась полезная фраза? Её можно сохранить в личный словарь и потом попросить примеры.', {
            reply_markup: new InlineKeyboard().text('📚 Открыть словарь', 'ui:words:1'),
          });
        } else if (conversationCount === 3 && await store.markTipSeen(userId, 'settings')) {
          await ctx.reply('⚙️ Можно настроить сложность и количество исправлений под себя.', {
            reply_markup: new InlineKeyboard().text('Настроить', 'ui:settings'),
          });
        }
      }
      if (speech.canSpeak && (settings.voiceMode === 'on' || settings.voiceMode === 'auto' && audio)) {
        try {
          const voice = await speech.speak(result.answer.reply);
          await ctx.replyWithVoice(new InputFile(voice, 'ellie.ogg'));
        } catch {
          logger.warn({ feature: 'tts' }, 'Voice response unavailable');
          await ctx.reply('Текстовый ответ готов, но озвучка сейчас недоступна. Можно продолжать разговор текстом.');
        }
      }
      logger.info({ provider: result.provider, input: audio ? 'voice' : 'text' }, 'Conversation turn completed');
    });
  });
  bot.catch(() => logger.error('Unhandled bot update error'));
  return bot;
}

export function parseVocabularyEntry(input: string): { term: string; translation: string } | null {
  const separator = input.indexOf('|');
  if (separator < 0) return null;
  const term = input.slice(0, separator).trim().replace(/\s+/g, ' ');
  const translation = input.slice(separator + 1).trim().replace(/\s+/g, ' ');
  if (!term || !translation || term.length > 160 || translation.length > 400) return null;
  return { term, translation };
}

function normalizeUiInput(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : '';
}

function escapeHtmlForBot(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function replyLong(ctx: Context, text: string, keyboard?: InlineKeyboard) {
  const chunks = splitText(text);
  for (const [index, chunk] of chunks.entries()) {
    await ctx.reply(chunk, {
      link_preview_options: { is_disabled: true },
      ...(keyboard && index === chunks.length - 1 ? { reply_markup: keyboard } : {}),
    });
  }
}

async function withTyping(ctx: Context, work: () => Promise<void>) {
  const send = () => ctx.replyWithChatAction('typing').catch(() => undefined);
  await send();
  const timer = setInterval(() => { void send(); }, 4000);
  timer.unref();
  try { await work(); } finally { clearInterval(timer); }
}

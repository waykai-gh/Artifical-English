import { InlineKeyboard } from 'grammy';
import type { Settings } from '../domain.js';
import type { VocabularyItem } from '../storage.js';

export type Screen = { text: string; keyboard: InlineKeyboard };
export type SettingsSection = 'level' | 'corrections' | 'language' | 'voice';
export const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const short = (text: string, length = 45) => Array.from(text).length > length ? `${Array.from(text).slice(0, length - 1).join('')}…` : text;
export const menuKeyboard = () => new InlineKeyboard()
  .text('📚 Мой словарь', 'ui:words:1').text('⚙️ Настройки', 'ui:settings').row()
  .text('ℹ️ Информация', 'ui:guide');
export const backToMenu = () => new InlineKeyboard().text('‹ Меню', 'ui:menu');
export const levelLabels: Record<Settings['level'], string> = {
  A0: 'A0 · Начинаю с нуля', A1: 'A1 · Первые шаги', A2: 'A2 · Простые разговоры', B1: 'B1 · Повседневные темы',
  B2: 'B2 · Свободнее и подробнее', C1: 'C1 · Сложные темы', C2: 'C2 · Тонкости языка',
};
export const correctionLabels: Record<Settings['corrections'], string> = { detailed: 'Подробно', gentle: 'Коротко', off: 'Без исправлений' };
export const voiceLabels: Record<Settings['voiceMode'], string> = { auto: 'На голосовые', on: 'Всегда', off: 'Только текст' };

export function consentScreen(): Screen {
  return {
    text: '<b>Перед началом</b>\n\nEllie — AI-тренажёр английского. Продукт создан с помощью ИИ, а ответы могут содержать ошибки.\n\nДля работы бот сохраняет Telegram ID, настройки, тексты/расшифровки, ответы и словарь. Сообщения передаются AI-сервису; Telegram ID туда не передаётся. Владелец бота может просматривать сохранённые данные для поддержки.\n\nНажимая «Согласен», ты разрешаешь такую обработку. Согласие можно отозвать командой /forget. Для защиты квот после удаления до 48 часов остаётся счётчик с кодом вместо Telegram ID. Доступ поддержки фиксируется без текстов и открытых ID на 90 дней.',
    keyboard: new InlineKeyboard().text('Согласен, продолжить', 'ui:consent:accept').row()
      .text('Подробнее о данных', 'ui:privacy:consent').row().text('Не согласен', 'ui:consent:decline'),
  };
}

export function consentDeclinedScreen(): Screen {
  return {
    text: 'Хорошо. Без согласия обучение недоступно. История, словарь и профиль удалены; защитные счётчики и журнал доступа хранятся в сроки из политики.\n\nЕсли передумаешь, открой /start.',
    keyboard: new InlineKeyboard().text('Вернуться', 'ui:consent:show'),
  };
}

export function levelOnboardingScreen(): Screen {
  const keyboard = new InlineKeyboard();
  for (const [value, label] of Object.entries(levelLabels)) keyboard.text(label, `ui:onboard:${value}`).row();
  return {
    text: '<b>С чего начнём?</b>\n\nВыбери примерный уровень. Если не знаешь алфавит или самые базовые фразы — выбирай A0. Потом уровень можно изменить в настройках.',
    keyboard,
  };
}

export function welcomeScreen(returning: boolean, level: Settings['level'] = 'B1'): Screen {
  if (level === 'A0') return {
    text: returning
      ? 'С возвращением! Можно писать по-русски — будем добавлять английский постепенно.\n\n<b>Hello</b> — привет («хэлоу»).'
      : 'Отлично, начнём с нуля. Можно писать только по-русски: я не буду требовать, чтобы ты сразу говорил на английском.\n\nПервая фраза: <b>Hello</b> — привет («хэлоу»).',
    keyboard: new InlineKeyboard().text('Начать с азов', 'ui:topic:basics').text('Меню', 'ui:menu'),
  };
  return {
    text: returning
      ? 'Рада снова тебя видеть! Просто напиши — продолжим практиковать английский.\n\n<b>How has your day been?</b>'
      : 'Привет, я Ellie! Поговорим по-английски — о твоём дне, планах или о чём захочется. Я помогу с формулировками и объясню ошибки по-русски.\n\nМожно начать с пары слов.\n\n<b>Hi! How was your day?</b>',
    keyboard: new InlineKeyboard().text('Помоги начать', 'ui:topics').text('Меню', 'ui:menu'),
  };
}

export function mainMenuScreen(stats: { turns: number; vocabulary: number }): Screen {
  return {
    text: `<b>Твоя практика английского</b>\n\nЧтобы общаться, просто пиши в чат. Здесь — всё, что может пригодиться по ходу.\n\nРеплик в практике: ${stats.turns} · В словаре: ${stats.vocabulary}`,
    keyboard: menuKeyboard(),
  };
}

export function topicsScreen(level: Settings['level'] = 'B1'): Screen {
  if (level === 'A0') return {
    text: '<b>Первые шаги</b>\n\nВыбери тему. Отвечать можно по-русски.',
    keyboard: new InlineKeyboard().text('🔤 Алфавит и звуки', 'ui:topic:alphabet').row()
      .text('👋 Приветствие', 'ui:topic:basics').row()
      .text('👤 Как рассказать о себе', 'ui:topic:intro').row().text('‹ Назад', 'ui:chat'),
  };
  return {
    text: '<b>Начнём с чего-то знакомого</b>\n\nВыбери тему, и я задам простой вопрос. Можно и просто написать свою мысль.',
    keyboard: new InlineKeyboard().text('☀️ Мой день', 'ui:topic:day').row()
      .text('☕ Еда и привычки', 'ui:topic:food').row()
      .text('✈️ Путешествия', 'ui:topic:travel').row().text('‹ Назад', 'ui:chat'),
  };
}

export function settingsScreen(settings: Settings, note = ''): Screen {
  return {
    text: `<b>Настройки под тебя</b>\n\nСложность: ${levelLabels[settings.level]}\nИсправления: ${correctionLabels[settings.corrections]}\nОбъяснения: ${settings.explanationLanguage === 'ru' ? 'по-русски' : 'по-английски'}\nГолосовые ответы: ${voiceLabels[settings.voiceMode]}${note ? `\n\n${escapeHtml(note)}` : ''}`,
    keyboard: new InlineKeyboard().text('Сложность', 'ui:settings:level').text('Исправления', 'ui:settings:corrections').row()
      .text('Язык объяснений', 'ui:settings:language').text('Голосовые ответы', 'ui:settings:voice').row()
      .text('История и данные', 'ui:data').row().text('‹ Меню', 'ui:menu'),
  };
}

export function settingsChoiceScreen(section: SettingsSection, settings: Settings, canSpeak: boolean): Screen {
  const keyboard = new InlineKeyboard();
  let text: string;
  if (section === 'level') {
    text = '<b>Насколько сложным будет английский?</b>\n\nВыбери комфортный уровень. Если станет слишком легко или сложно, его можно поменять в любой момент.';
    for (const [value, label] of Object.entries(levelLabels)) keyboard.text(`${settings.level === value ? '✓ ' : ''}${label}`, `ui:set:level:${value}`).row();
  } else if (section === 'corrections') {
    text = '<b>Как разбирать ошибки?</b>\n\nПодробно — исправления с объяснениями.\nКоротко — только самые важные моменты.\nБез исправлений — просто разговор.';
    for (const [value, label] of Object.entries(correctionLabels)) keyboard.text(`${settings.corrections === value ? '✓ ' : ''}${label}`, `ui:set:corrections:${value}`).row();
  } else if (section === 'language') {
    text = '<b>На каком языке объяснять?</b>\n\n'
      + (settings.level === 'A0' ? 'На A0 основной разговор идёт по-русски.' : 'Сам разговор остаётся на английском.')
      + ' Этот выбор меняет язык разбора ошибок и примеров из словаря.';
    keyboard.text(`${settings.explanationLanguage === 'ru' ? '✓ ' : ''}По-русски`, 'ui:set:language:ru').row()
      .text(`${settings.explanationLanguage === 'en' ? '✓ ' : ''}По-английски`, 'ui:set:language:en').row();
  } else {
    text = '<b>Когда отвечать голосом?</b>\n\nНа голосовые — озвучиваю ответ, если ты прислал аудио.\nВсегда — добавляю голос к каждому ответу.\nТолько текст — общаемся без озвучки.';
    if (!canSpeak) text += '\n\nСейчас озвучка недоступна. Текстовый разговор работает.';
    for (const [value, label] of Object.entries(voiceLabels)) {
      if (canSpeak || value === 'off') keyboard.text(`${settings.voiceMode === value ? '✓ ' : ''}${label}`, `ui:set:voice:${value}`).row();
    }
  }
  return { text, keyboard: keyboard.text('‹ Настройки', 'ui:settings') };
}

export function dictionaryScreen(result: { items: VocabularyItem[]; page: number; pages: number; total: number }): Screen {
  const keyboard = new InlineKeyboard().text('＋ Добавить слово или фразу', 'ui:add').row();
  for (const item of result.items) keyboard.text(short(item.term, 52), `ui:word:${item.id}:${result.page}`).row();
  if (result.pages > 1) {
    if (result.page > 1) keyboard.text('‹ Назад', `ui:words:${result.page - 1}`);
    keyboard.text(`${result.page} / ${result.pages}`, `ui:words:${result.page}`);
    if (result.page < result.pages) keyboard.text('Дальше ›', `ui:words:${result.page + 1}`);
    keyboard.row();
  }
  keyboard.text('‹ Меню', 'ui:menu');
  return {
    text: result.total
      ? `<b>Мой словарь · ${result.total}</b>\n\n${result.items.map(item => `${escapeHtml(short(item.term, 60))} — ${escapeHtml(short(item.translation, 110))}`).join('\n\n')}\n\nНажми на фразу, чтобы открыть примеры и объяснение.`
      : '<b>Мой словарь</b>\n\nВстретилась полезная фраза? Сохрани её вместе с переводом — здесь можно вернуться к ней и посмотреть примеры.\n\nДобавим первую?',
    keyboard,
  };
}

export function vocabularyScreen(item: VocabularyItem, page = 1, saved = false): Screen {
  return {
    text: `${saved ? '✓ Сохранено\n\n' : ''}<b>${escapeHtml(item.term)}</b>\n${escapeHtml(item.translation)}\n\nПосмотрим, как это звучит в живом английском?`,
    keyboard: new InlineKeyboard().text('💬 Примеры и употребление', `ui:explain:${item.id}:${page}`).row()
      .text('Изменить перевод', `ui:edit:${item.id}:${page}`).text('Удалить', `ui:delete:${item.id}:${page}`).row()
      .text('‹ Мой словарь', `ui:words:${page}`).text('Меню', 'ui:menu'),
  };
}

export function guideScreen(canTranscribe: boolean): Screen {
  return {
    text: '<b>Как здесь учиться</b>\n\nПросто напиши в чат или выбери тему. Я отвечу, помогу с формулировкой и разберу ошибки. Для самого начального уровня есть A0.'
      + (canTranscribe ? '\n\n🎧 Можно прислать голосовое. Покажу, что расслышала, и отвечу.' : '')
      + '\n\n📚 Слова можно сохранять в словарь. Сложность и количество исправлений меняются в настройках.\n\nПродукт создан с помощью ИИ; ответы могут содержать ошибки.',
    keyboard: new InlineKeyboard().text('Выбрать тему', 'ui:topics').row().text('Данные и приватность', 'ui:privacy:guide').row().text('‹ Меню', 'ui:menu'),
  };
}

export function dataScreen(): Screen {
  return {
    text: '<b>История и данные</b>\n\nНовый разговор — очистить контекст беседы. Словарь и настройки сохранятся.\n\nУдалить мои данные — убрать из бота разговоры, словарь и настройки.',
    keyboard: new InlineKeyboard().text('Начать новый разговор', 'ui:reset').row()
      .text('Как хранятся данные', 'ui:privacy').row().text('Удалить мои данные', 'ui:forget').row().text('‹ Настройки', 'ui:settings'),
  };
}

export function confirmScreen(action: 'reset' | 'forget' | 'deleteWord', nonce: string, term?: string): Screen {
  const text = action === 'reset'
    ? '<b>Начать новый разговор?</b>\n\nКонтекст текущей беседы будет очищен. Словарь и настройки останутся.'
    : action === 'forget'
      ? '<b>Удалить все мои данные?</b>\n\nБот удалит историю, весь словарь и настройки. Вернуть их через бота не получится. Защитный счётчик запросов останется до 48 часов; лимит не обнулится.'
      : `<b>Удалить эту запись?</b>\n\n${escapeHtml(term ?? '')}\n\nОна исчезнет из твоего словаря.`;
  return {
    text,
    keyboard: new InlineKeyboard().text(action === 'reset' ? 'Да, начать заново' : 'Да, удалить', `ui:confirm:${nonce}`).row()
      .text('Отмена', `ui:cancel:${nonce}`),
  };
}

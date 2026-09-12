import { GrammyError } from 'grammy';
import type { Api } from 'grammy';
import type { BotCommand, BotCommandScope, LanguageCode } from 'grammy/types';

export const publicCommands: BotCommand[] = [
  { command: 'start', description: 'Начать общение' },
  { command: 'menu', description: 'Открыть меню' },
];

type MenuApi = Pick<Api, 'setMyCommands' | 'deleteMyCommands' | 'setChatMenuButton'>;

/** Telegram has no endpoint that lists all existing scope/language overrides. */
export async function configureTelegramMenu(api: MenuApi, knownPrivateChatIds: number[] = []): Promise<void> {
  // Establish the fallback first, so deleting an override never exposes an old command list.
  await api.setMyCommands(publicCommands, { scope: { type: 'default' } });
  for (const language_code of ['ru', 'en'] as LanguageCode[]) {
    await api.deleteMyCommands({ scope: { type: 'default' }, language_code });
  }
  const scopes: BotCommandScope[] = [
    { type: 'all_private_chats' },
    ...[...new Set(knownPrivateChatIds)].filter(id => Number.isSafeInteger(id) && id > 0)
      .map(chat_id => ({ type: 'chat' as const, chat_id })),
  ];
  for (const scope of scopes) {
    for (const language_code of [undefined, 'ru', 'en'] as (LanguageCode | undefined)[]) {
      try {
        await api.deleteMyCommands({ scope, language_code });
      } catch (error) {
        // A user may have blocked the bot or deleted the chat since the last
        // interaction. That stale override must not prevent a clean startup.
        if (scope.type !== 'chat' || !(error instanceof GrammyError) || ![400, 403].includes(error.error_code)) throw error;
      }
    }
  }
  await api.setChatMenuButton({ menu_button: { type: 'commands' } });
}

/** Repair a user's most specific scope, including a previously unknown UI language. */
export async function repairPrivateChatMenu(api: MenuApi, chatId: number, languageCode?: string): Promise<void> {
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return;
  const scope = { type: 'chat' as const, chat_id: chatId };
  await api.setMyCommands(publicCommands, { scope });
  // Telegram uses ISO 639-1 here, while the User object may have an IETF language tag.
  const language_code = languageCode?.toLowerCase().split(/[-_]/)[0] as LanguageCode | undefined;
  if (language_code && /^[a-z]{2}$/.test(language_code)) {
    await api.setMyCommands(publicCommands, { scope, language_code });
  }
  await api.setChatMenuButton({ chat_id: chatId, menu_button: { type: 'commands' } });
}

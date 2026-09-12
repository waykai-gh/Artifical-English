import type { Logger } from 'pino';
import type { AiRouter } from './ai/router.js';
import type { Store } from './storage.js';
import type { SpeechService } from './speech.js';

export interface BotDependencies {
  store: Store;
  ai: Pick<AiRouter, 'chat' | 'explainVocabulary'>;
  speech: SpeechService;
  logger: Pick<Logger, 'warn' | 'error' | 'info'>;
}

import type { Answer, Settings, VocabularyUsage } from './domain.js';
import type { VocabularyItem } from './storage.js';

// Telegram limits are in UTF-16 code units; avoid splitting surrogate pairs.
export function splitText(text: string, maxLength = 3800): string[] {
  if (maxLength < 2) throw new Error('Chunk size must be at least 2');
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    let end = rest.lastIndexOf('\n', maxLength);
    if (end < maxLength / 2) end = rest.lastIndexOf(' ', maxLength);
    if (end < maxLength / 2) end = maxLength;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1]!)) end--;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function formatAnswer(answer: Answer, settings: Settings, fromVoice: boolean): string {
  if (!answer.corrections.length) return answer.reply;
  const ru = settings.explanationLanguage === 'ru';
  const heading = ru ? 'Разбор ошибок' : 'Language notes';
  const caveat = fromVoice ? (ru ? '\nПо расшифровке: распознавание речи иногда ошибается.' : '\nBased on the transcript; speech recognition can make mistakes.') : '';
  return `${answer.reply}\n\n📝 ${heading}${caveat}\n\n${answer.corrections.map((c, i) =>
    `${i + 1}. ${c.original}\n→ ${c.corrected}\n${c.explanation}`).join('\n\n')}`;
}

export function formatVocabularyUsage(item: VocabularyItem, usage: VocabularyUsage, settings: Settings): string {
  const en = settings.explanationLanguage === 'en';
  const patterns = usage.patterns.length ? `\n\n🔗 ${en ? 'Common patterns' : 'Типичные сочетания'}\n${usage.patterns.map(p => `• ${p.pattern}\n  ${p.explanation}`).join('\n')}` : '';
  const mistakes = usage.commonMistakes.length ? `\n\n⚠️ ${en ? 'Common mistakes' : 'Частые ошибки'}\n${usage.commonMistakes.map(m => `• ${m}`).join('\n')}` : '';
  return `📖 #${item.id} ${item.term} — ${item.translation}\n\n${en ? 'Meaning and nuance' : 'Значение и оттенки'}\n${usage.meaning}\n\n${en ? 'Register and usage' : 'Где уместно'}\n${usage.register}${patterns}\n\n💬 ${en ? 'Examples' : 'Примеры'}\n${usage.examples.map(e => `• ${e.english}\n  ${e.translation}`).join('\n')}${mistakes}`;
}

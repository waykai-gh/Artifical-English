import { z } from 'zod';
import type { Config } from '../config.js';
import { buildPrompt, buildVocabularyPrompt, parseAnswer, parseVocabularyUsage, type Answer, type ChatInput, type Message, type ProviderName, type VocabularyInput, type VocabularyUsage } from '../domain.js';
import { requestJson, type Fetcher } from './http.js';

export interface ChatProvider {
  name: ProviderName;
  chat(input: ChatInput): Promise<Answer>;
  explainVocabulary(input: VocabularyInput): Promise<VocabularyUsage>;
}

const chatResponse = z.object({ choices: z.array(z.object({
  message: z.object({ content: z.string() }),
  finish_reason: z.string().nullish(),
})).min(1) });

const geminiResponse = z.object({ candidates: z.array(z.object({
  content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })) }),
  finishReason: z.string().optional(),
})).min(1) });

export function geminiText(raw: unknown): string {
  const first = geminiResponse.parse(raw).candidates[0]!;
  if (first.finishReason && first.finishReason !== 'STOP') throw new Error('Incomplete Gemini response');
  return first.content.parts.filter(p => !p.thought).map(p => p.text ?? '').join('');
}

export function createProviders(c: Config, fetcher: Fetcher = fetch): ChatProvider[] {
  const providers: ChatProvider[] = [];
  for (const name of c.AI_PROVIDER_ORDER) {
    const key = { groq: c.GROQ_API_KEY, cloudflare: c.CLOUDFLARE_API_TOKEN, gemini: c.GEMINI_API_KEY, openrouter: c.OPENROUTER_API_KEY }[name];
    if (!key) continue;
    const completeJson = async (system: string, messages: Message[]): Promise<string> => {
      if (name === 'gemini') {
        const raw = await requestJson(fetcher,
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(c.GEMINI_CHAT_MODEL)}:generateContent`, {
            method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
              generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 },
            }),
          }, c.PROVIDER_TIMEOUT_MS);
        return geminiText(raw);
      }
      const raw = await requestJson(fetcher, name === 'groq'
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : name === 'cloudflare' ? `https://api.cloudflare.com/client/v4/accounts/${c.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`
        : 'https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: name === 'groq' ? c.GROQ_CHAT_MODEL : name === 'cloudflare' ? c.CLOUDFLARE_CHAT_MODEL : c.OPENROUTER_CHAT_MODEL,
          messages: [{ role: 'system', content: system }, ...messages],
          response_format: { type: 'json_object' },
          max_tokens: 4096,
          ...(name === 'groq' && c.GROQ_CHAT_MODEL.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
        }),
      }, c.PROVIDER_TIMEOUT_MS);
      const first = chatResponse.parse(raw).choices[0]!;
      if (first.finish_reason && first.finish_reason !== 'stop') throw new Error('Incomplete AI response');
      return first.message.content;
    };
    providers.push({
      name,
      async chat(input) {
        return parseAnswer(await completeJson(buildPrompt(input.settings, input.fromVoice), [...input.history, { role: 'user', content: input.text }]));
      },
      async explainVocabulary(input) {
        const data = JSON.stringify({ englishTerm: input.term, userTranslation: input.translation });
        return parseVocabularyUsage(await completeJson(buildVocabularyPrompt(input.settings), [{ role: 'user', content: data }]));
      },
    });
  }
  return providers;
}

import { describe, expect, it, vi } from 'vitest';
import { defaults, readConfig } from '../src/config.js';
import { buildPrompt, normalizeAnswer, parseAnswer, parseVocabularyUsage, UserError } from '../src/domain.js';
import { createProviders } from '../src/ai/providers.js';
import { ProviderError, readLimited, requestJson, retryAfter } from '../src/ai/http.js';
import { AiRouter } from '../src/ai/router.js';
import { answer, testConfig, vocabularyUsage } from './helpers.js';

const input = { settings: defaults(testConfig()), text: 'Yesterday I go to the shop.', history: [], fromVoice: false };

describe('tutor output and settings', () => {
  it('parses fenced JSON but rejects missing feedback structure', () => {
    expect(parseAnswer('```json\n' + JSON.stringify(answer) + '\n```')).toEqual(answer);
    expect(() => parseAnswer('{"reply":"hello"}')).toThrow();
  });
  it('parses a structured vocabulary explanation', () => {
    expect(parseVocabularyUsage(JSON.stringify(vocabularyUsage))).toEqual(vocabularyUsage);
    expect(() => parseVocabularyUsage('{"meaning":"only one field"}')).toThrow();
  });
  it('removes invented corrections and honors off mode', () => {
    const raw = { ...answer, corrections: [...answer.corrections, { original: 'not present', corrected: 'present', explanation: 'test' }] };
    expect(normalizeAnswer(raw, input).corrections).toHaveLength(1);
    expect(normalizeAnswer(raw, { ...input, settings: { ...input.settings, corrections: 'off' } }).corrections).toEqual([]);
  });
  it('does not pretend to assess pronunciation from transcripts', () => {
    const prompt = buildPrompt(input.settings, true);
    expect(prompt).toContain('Russian');
    expect(prompt).toContain('detailed');
    expect(prompt).toContain('cannot assess pronunciation');
  });
  it('supports existing keys without allowing arbitrary credential destinations', () => {
    const c = readConfig({ BOT_TOKEN: `123456:${'x'.repeat(35)}`, DATABASE_URL: 'postgresql://localhost/test',
      LLM_PROVIDER_NAME: 'groq', LLM_API_KEY: 'old-groq', LLM_MODEL: 'openai/gpt-oss-120b',
      LLM_FALLBACK_PROVIDER_NAME: 'cloudflare', LLM_FALLBACK_API_KEY: 'old-cf',
      LLM_FALLBACK_API_URL: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run/test`,
    });
    expect(c.GROQ_API_KEY).toBe('old-groq');
    expect(c.CLOUDFLARE_ACCOUNT_ID).toBe('a'.repeat(32));
    expect(c.PUBLIC_BOT).toBe('true');
    expect(() => readConfig({ ...c as unknown as NodeJS.ProcessEnv, AI_PROVIDER_ORDER: 'groq', CLOUDFLARE_ACCOUNT_ID: '', LLM_FALLBACK_PROVIDER_NAME: 'cloudflare', LLM_FALLBACK_API_URL: `https://evil.test/accounts/${'a'.repeat(32)}` })).toThrow();
  });
  it('rejects paid OpenRouter models and redacts bad config values', () => {
    expect(() => testConfig({ OPENROUTER_CHAT_MODEL: 'openrouter/auto' })).toThrow('OPENROUTER_CHAT_MODEL');
    expect(() => testConfig({ BOT_TOKEN: 'private-secret-value' })).toThrow('BOT_TOKEN');
    try { testConfig({ BOT_TOKEN: 'private-secret-value' }); } catch (e) { expect(String(e)).not.toContain('private-secret-value'); }
  });
});

describe('provider routing', () => {
  it('falls back on a quota failure and honors retry-after without retry storms', async () => {
    let now = 0;
    const primary = { name: 'groq' as const, chat: vi.fn().mockRejectedValueOnce(new ProviderError(429, 120000)).mockResolvedValue(answer), explainVocabulary: vi.fn().mockResolvedValue(vocabularyUsage) };
    const fallback = { name: 'cloudflare' as const, chat: vi.fn().mockResolvedValue(answer), explainVocabulary: vi.fn().mockResolvedValue(vocabularyUsage) };
    const logger = { warn: vi.fn() };
    const router = new AiRouter([primary, fallback], logger, () => now);
    expect((await router.chat(input)).provider).toBe('cloudflare');
    now = 60000;
    await router.chat(input);
    expect(primary.chat).toHaveBeenCalledTimes(1);
    now = 120001;
    expect((await router.chat(input)).provider).toBe('groq');
  });
  it('falls back when the first provider returns invalid JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'not JSON' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }));
    const router = new AiRouter(createProviders(testConfig({ GEMINI_API_KEY: 'gemini-test' }), fetcher), { warn: vi.fn() });
    expect((await router.chat(input)).provider).toBe('gemini');
    const secondRequest = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(secondRequest.contents[0].parts[0].text).toBe(input.text);
  });
  it('sends structured history to Cloudflare using its account endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] }));
    const providers = createProviders(testConfig({ AI_PROVIDER_ORDER: 'cloudflare', CLOUDFLARE_API_TOKEN: 'cf-test', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }), fetcher);
    await providers[0]!.chat({ ...input, history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '{"reply":"Hello","corrections":[]}' }] });
    expect(String(fetcher.mock.calls[0]![0])).toContain('/ai/v1/chat/completions');
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(body.messages).toHaveLength(4);
    expect(body.messages.at(-1).content).toBe(input.text);
  });
  it('passes vocabulary as quoted JSON data and returns structured usage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: JSON.stringify(vocabularyUsage) }, finish_reason: 'stop' }] }));
    const provider = createProviders(testConfig(), fetcher)[0]!;
    const result = await provider.explainVocabulary({ settings: input.settings, term: 'take off', translation: 'взлетать' });
    expect(result.examples).toHaveLength(2);
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(JSON.parse(body.messages.at(-1).content)).toEqual({ englishTerm: 'take off', userTranslation: 'взлетать' });
    expect(body.messages[0].content).toContain('quoted data');
  });
  it('returns an actionable error when all providers fail', async () => {
    const router = new AiRouter([{ name: 'groq', chat: async () => { throw new ProviderError(401); }, explainVocabulary: async () => { throw new ProviderError(401); } }], { warn: vi.fn() });
    await expect(router.chat(input)).rejects.toBeInstanceOf(UserError);
  });
});

describe('HTTP boundaries', () => {
  it('handles retry-after seconds, HTTP dates, and garbage', () => {
    expect(retryAfter('12', 0)).toBe(12000);
    expect(retryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0)).toBe(60000);
    expect(retryAfter('bad', 0)).toBe(0);
  });
  it('enforces actual streamed size even without content-length', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.close(); } }));
    await expect(readLimited(response, 10)).rejects.toThrow('size limit');
  });
  it('does not leak request URLs or provider response bodies in errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('https://example.test/SECRET_KEY'));
    await expect(requestJson(fetcher, 'https://example.test', {}, 1000)).rejects.toThrow('AI provider request failed (0)');
  });
});

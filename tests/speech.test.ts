import { describe, expect, it, vi } from 'vitest';
import { Speech, wavsToVoice } from '../src/speech.js';
import { splitText } from '../src/format.js';
import { testConfig } from './helpers.js';

function silentWav() {
  const pcm = Buffer.alloc(3200);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe('voice and message boundaries', () => {
  it('converts and joins WAV chunks to genuine OGG Opus with ffmpeg', async () => {
    const result = await wavsToVoice([silentWav(), silentWav()]);
    expect(result.subarray(0, 4).toString()).toBe('OggS');
    expect(result.includes(Buffer.from('OpusHead'))).toBe(true);
  });

  it('splits long text within Telegram/TTS limits without broken emojis', () => {
    const text = '🙂'.repeat(4100);
    const parts = splitText(text, 3800);
    expect(parts.join('')).toBe(text);
    expect(parts.every(p => p.length <= 3800 && p.isWellFormed())).toBe(true);
    expect(splitText('Hello world. '.repeat(100), 200).every(p => p.length <= 200)).toBe(true);
  });

  it('transcribes OGG via multipart without forcing translation or grammar correction', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: 'Yesterday I go shopping.' }));
    const speech = new Speech(testConfig(), fetcher);
    expect(await speech.transcribe(Buffer.from('ogg'), 'audio/ogg', 'recording.ogg')).toBe('Yesterday I go shopping.');
    const form = fetcher.mock.calls[0]![1]!.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('language')).toBeNull();
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('falls back to Gemini transcription and refuses oversized input before upload', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: 'Hello there.' }] }, finishReason: 'STOP' }] }));
    const speech = new Speech(testConfig({ GEMINI_API_KEY: 'test-gemini', MAX_AUDIO_BYTES: '1024' }), fetcher);
    expect(await speech.transcribe(Buffer.from('ogg'), 'audio/ogg', 'recording.ogg')).toBe('Hello there.');
    expect(String(fetcher.mock.calls[1]![0])).toContain('generativelanguage.googleapis.com');
    await expect(speech.transcribe(Buffer.alloc(1025), 'audio/ogg', 'recording.ogg')).rejects.toThrow('большой');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects empty transcripts without making up a conversation', async () => {
    const speech = new Speech(testConfig(), vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: '  ' })));
    await expect(speech.transcribe(Buffer.from('ogg'), 'audio/ogg', 'recording.ogg')).rejects.toThrow('расслышать');
  });

  it('sends every TTS chunk within the provider limit and emits OGG', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array(silentWav())));
    const speech = new Speech(testConfig({ LOCAL_TTS_FALLBACK: 'false' }), fetcher);
    const result = await speech.speak('Hello, how are you today? '.repeat(20));
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetcher.mock.calls) expect(JSON.parse(String(call[1]!.body)).input.length).toBeLessThanOrEqual(200);
    expect(result.subarray(0, 4).toString()).toBe('OggS');
  });
});

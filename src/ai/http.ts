export class ProviderError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs = 0) {
    super(`AI provider request failed (${status})`);
  }
}

export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(86_400_000, Math.max(0, ms)) : 0;
}

export async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Response exceeds size limit');
  }
  if (!response.body) throw new Error('Empty response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Response exceeds size limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type Fetcher = typeof fetch;

export async function requestBytes(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(response.status, retryAfter(response.headers.get('retry-after')));
    }
    return await readLimited(response, maxBytes);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Fetch errors may contain secret-bearing Telegram file URLs. Never propagate them.
    throw new ProviderError(0);
  }
}

export async function requestJson(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  return JSON.parse((await requestBytes(fetcher, url, init, timeoutMs, 512 * 1024)).toString('utf8'));
}

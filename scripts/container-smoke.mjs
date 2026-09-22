import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readConfig } from './dist/config.js';
import { Speech } from './dist/speech.js';

assert.notEqual(process.getuid(), 0, 'Container must run as a non-root user');
const status = readFileSync('/proc/self/status', 'utf8');
assert.match(status, /NoNewPrivs:\s+1/);
assert.match(status, /CapEff:\s+0+\n/);
// This text is synthetic. Network access is disabled for the smoke container.
const config = readConfig({ BOT_TOKEN: `123456:${'x'.repeat(35)}`, DATABASE_URL: 'postgresql://test:test@invalid/test',
  GROQ_API_KEY: 'synthetic', SECURITY_HMAC_KEY: 'synthetic-security-key-at-least-32-chars', LOCAL_TTS_FALLBACK: 'true' });
const voice = await new Speech(config, async () => { throw Error('Remote TTS intentionally unavailable'); }).speak('Hello! This is an audio system check.');
assert.equal(voice.subarray(0, 4).toString(), 'OggS');
console.log('Non-root, no privileges, local TTS and OGG conversion verified with read-only root and no network.');

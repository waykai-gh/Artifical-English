import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  // PGlite starts a WASM database per fixture; bound parallelism on small hosts.
  maxWorkers: 2,
  testTimeout: 15000,
  hookTimeout: 20000,
} });

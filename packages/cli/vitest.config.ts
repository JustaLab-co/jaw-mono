import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@jaw.id/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The command suites load the oclif manifest in a `beforeAll` and the MCP
    // ones stand a server up over an in-memory transport, both through vite's
    // transform. That is seconds of real work rather than a hang, and the
    // defaults are sized for tests that do none: with the whole workspace
    // testing at once, one MCP case went 9ms over the 5s budget and seven
    // command suites went over the 10s one, so a green suite depended on how
    // busy the machine was. Still bounded, so something that truly hangs fails.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});

import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the SDK to its TS source so tests run against the source, not
      // the last build of `dist`. Mirrors packages/wagmi and apps/keys-jaw-id.
      '@jaw.id/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
  },
});

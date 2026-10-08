import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@jaw.id/agent': resolve(__dirname, '../../packages/agent/src/index.ts'),
    },
  },
  test: {
    watch: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});

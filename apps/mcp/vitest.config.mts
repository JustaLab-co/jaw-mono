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
    // Each file migrates its own in-memory database, which is slow when nx runs suites side by side.
    hookTimeout: 60_000,
  },
});

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
    // Repairs the `localStorage` global on Node 25+. See the file for why.
    setupFiles: ['../../vitest.setup.localstorage.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    watch: false,
  },
});

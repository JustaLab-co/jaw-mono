import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@jaw.id/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    // Used only under --coverage. `include` counts files no test imports as
    // uncovered, and the thresholds sit at this project's current coverage.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['html', 'json-summary', 'text-summary'],
      // A failing test still writes the summary the PR check compares.
      reportOnFailure: true,
      reportsDirectory: '../../coverage/packages/wagmi',
      thresholds: { lines: 31, branches: 86, functions: 67, statements: 31 },
    },
    globals: true,
    environment: 'node',
    // Repairs the `localStorage` global on Node 25+. See the file for why.
    setupFiles: ['../../vitest.setup.localstorage.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    watch: false,
  },
});

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
    // Used only under --coverage. `include` counts files no test imports as
    // uncovered, and the thresholds sit at this project's current coverage.
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      reporter: ['html', 'json-summary', 'text-summary'],
      // A failing test still writes the summary the PR check compares.
      reportOnFailure: true,
      reportsDirectory: '../../coverage/apps/playground',
      thresholds: { lines: 67, branches: 93, functions: 13, statements: 67 },
    },
    globals: true,
    environment: 'jsdom',
    include: ['lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
  },
});

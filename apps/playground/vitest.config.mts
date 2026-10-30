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
    // uncovered, and the thresholds sit a point under this project's coverage.
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      reporter: ['html', 'json-summary', 'text-summary'],
      // A failing test still writes the summary the PR check compares.
      reportOnFailure: true,
      reportsDirectory: '../../coverage/apps/playground',
      thresholds: { lines: 66, branches: 92, functions: 12, statements: 66 },
    },
    globals: true,
    environment: 'jsdom',
    include: ['lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
  },
});

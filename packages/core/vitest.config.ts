import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Used only under --coverage. `include` counts files no test imports as
    // uncovered, and the thresholds sit a point under this project's coverage.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['html', 'json-summary', 'text-summary'],
      // A failing test still writes the summary the PR check compares.
      reportOnFailure: true,
      reportsDirectory: '../../coverage/packages/core',
      thresholds: { lines: 86, branches: 86, functions: 86, statements: 86 },
    },
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});

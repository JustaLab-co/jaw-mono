import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Used only under --coverage. `include` counts files no test imports as
    // uncovered, and the thresholds sit at this project's current coverage.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['html', 'json-summary', 'text-summary'],
      // A failing test still writes the summary the PR check compares.
      reportOnFailure: true,
      reportsDirectory: '../../coverage/packages/core',
      thresholds: { lines: 87, branches: 87, functions: 87, statements: 87 },
    },
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});

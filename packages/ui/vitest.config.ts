import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Use the automatic JSX runtime (matches the package's tsconfig react-jsx) so
  // .tsx component tests don't need an explicit React import. Mirrors
  // apps/keys-jaw-id.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // Resolve the SDK to its TS source so tests don't require a built `dist`
      // (the Nx-inferred `test` target has no `^build` dependency, so core is
      // unbuilt in CI). Mirrors packages/wagmi and apps/keys-jaw-id.
      // Aliases match by prefix in order, so the subpath goes first or it
      // resolves to `src/index.ts/internal`.
      '@jaw.id/core/internal': resolve(__dirname, '../../packages/core/src/internal.ts'),
      '@jaw.id/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: {
    // Used only under --coverage. `include` counts files no test imports as
    // uncovered, and the thresholds sit a point under this project's coverage.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['html', 'json-summary', 'text-summary'],
      // A failing test still writes the summary the PR check compares.
      reportOnFailure: true,
      reportsDirectory: '../../coverage/packages/ui',
      thresholds: { lines: 72, branches: 80, functions: 76, statements: 72 },
    },
    globals: true,
    environment: 'node',
    // Repairs the `localStorage` global on Node 25. See the file for why.
    setupFiles: ['../../vitest.setup.localstorage.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});

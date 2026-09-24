import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Use the automatic JSX runtime (matches the app's tsconfig react-jsx) so
  // .tsx component tests don't need an explicit React import.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // Resolve the SDK to its TS source so tests don't require a built
      // `dist` (the Nx-inferred `test` target has no `^build` dependency, so
      // core is unbuilt in CI). Mirrors packages/wagmi.
      // Aliases match by prefix in order, so the subpath goes first or it
      // resolves to `src/index.ts/internal`.
      '@jaw.id/core/internal': resolve(__dirname, '../../packages/core/src/internal.ts'),
      '@jaw.id/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@jaw.id/ui': resolve(__dirname, '../../packages/ui/src/index.ts'),
    },
  },
  test: {
    // Run once and exit. The Nx-inferred `test` target invokes `vitest` (not
    // `vitest run`), which would otherwise start watch mode in an interactive
    // terminal — hanging the pre-push hook. Mirrors packages/wagmi.
    watch: false,
    globals: true,
    environment: 'node',
    // Repairs the `localStorage` global on Node 25+. See the file for why.
    setupFiles: ['../../vitest.setup.localstorage.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/.next/**'],
  },
});

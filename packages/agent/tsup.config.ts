import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node20',
  external: ['@jaw.id/core', 'viem', 'zod'],
});

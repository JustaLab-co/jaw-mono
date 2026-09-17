import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outDir: 'dist/cjs',
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: false,
  treeshake: true,
  external: ['viem', 'ox', 'zustand', 'axios', 'eventemitter3', 'mipd', 'qs', 'tslib'],
});

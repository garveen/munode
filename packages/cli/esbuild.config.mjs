import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  bundle: true,
  external: ['@munode/common', 'commander'], // 外部依赖
  banner: {
    js: '#!/usr/bin/env node',
  },
});
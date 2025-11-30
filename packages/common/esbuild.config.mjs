import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  bundle: true,
  external: ['winston'], // 外部依赖
});
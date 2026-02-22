import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts', 'src/cli.ts', 'src/database-worker.ts', 'src/permission-worker.ts'],
  outdir: 'dist',
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  bundle: true,
  external: ['@munode/common', '@munode/protocol', 'lru-cache', 'ws'], // 外部依赖
});
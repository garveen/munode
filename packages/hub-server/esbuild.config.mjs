import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts', 'src/cli.ts'],
  outdir: 'dist',
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  bundle: true,
  external: ['@munode/common', '@munode/protocol', 'sqlite', 'sqlite3', 'lru-cache'], // 外部依赖
});
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts', 'src/cli.ts'],
  outdir: 'dist',
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  bundle: true,
  external: ['@discordjs/opus', '@munode/common', '@munode/protocol', 'axios', 'commander', 'fluent-ffmpeg', 'form-data', 'node-fetch', 'ws'], // 外部依赖
});
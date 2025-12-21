import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  bundle: true, // 不打包，保持模块分离
  external: ['@munode/common', '@bufbuild/protobuf', 'msgpackr', 'ws'], // 外部依赖
});
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts', 'src/cli.ts', 'src/voice/crypto-worker.ts'],
  outdir: 'dist',
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  bundle: true,
  external: ['@grpc/grpc-js', '@grpc/proto-loader', '@maxmind/geoip2-node', '@munode/common', '@munode/protocol', 'axios', 'commander', 'ipaddr.js', 'long', 'lru-cache', 'protobufjs', 'winston', 'ws'], // 外部依赖
});
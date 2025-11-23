/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    target: 'node22',
  },
  test: {
    // bail: 1,
    environment: 'node',
    globals: true,
    include: ['tests/integration/suites/**/*.test.ts'],
    testTimeout: 30000, // 集成测试需要更长的超时时间
    hookTimeout: 60000, // setup/teardown 需要更长的时间
    pool: 'forks', // 使用 forks 以确保测试隔离
    poolOptions: {
      forks: {
        singleFork: true, // 使用单个进程以避免端口冲突
        isolate: true, // 确保完全隔离
      },
    },
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '__tests__/',
        '**/*.d.ts',
        '**/*.config.*',
      ],
    },
  },
  resolve: {
    alias: {
      '@munode/protocol': path.resolve(__dirname, 'packages/protocol/dist/index.js'),
      '@munode/common': path.resolve(__dirname, 'packages/common/dist/index.js'),
      '@munode/hub-server': path.resolve(__dirname, 'packages/hub-server/dist/index.js'),
      '@munode/edge-server': path.resolve(__dirname, 'packages/edge-server/dist/index.js'),
    },
  },
  optimizeDeps: {
    include: ['@munode/protocol', '@munode/common', '@munode/hub-server', '@munode/edge-server'],
  },
  ssr: {
    noExternal: ['@munode/protocol', '@munode/common', '@munode/hub-server', '@munode/edge-server'],
  },
});

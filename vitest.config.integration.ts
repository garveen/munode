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
    testTimeout: 60000, // 集成测试需要更长的超时时间（增加到60秒）
    hookTimeout: 60000, // setup/teardown 需要更长的时间
    teardownTimeout: 10000, // 强制 teardown 超时
    pool: 'forks', // 使用 forks 以确保测试隔离
    poolOptions: {
      forks: {
        singleFork: true, // 使用单个进程以避免端口冲突
        isolate: true, // 确保完全隔离
      },
    },
    // 减少日志输出
    silent: false, // 保留测试输出
    reporters: process.env.CI ? ['dot'] : ['default'], // CI 环境使用简洁输出
    outputFile: undefined, // 不写入文件
    logHeapUsage: false, // 禁用堆使用日志
    // 减少标准输出冗余
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
      '@munode/client': path.resolve(__dirname, 'packages/client/dist/index.js'),
    },
  },
  optimizeDeps: {
    include: ['@munode/protocol', '@munode/common', '@munode/hub-server', '@munode/edge-server'],
    exclude: ['ws'],
  },
  ssr: {
    noExternal: ['@munode/protocol', '@munode/common', '@munode/hub-server', '@munode/edge-server'],
  },
});

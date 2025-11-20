/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/integration/suites/**/*.test.ts'],
    testTimeout: 30000, // 集成测试需要更长的超时时间
    hookTimeout: 60000, // setup/teardown 需要更长的时间
    pool: 'forks', // 使用 forks 以确保测试隔离
    poolOptions: {
      forks: {
        singleFork: true, // 使用单个进程以避免端口冲突
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
});

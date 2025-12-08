/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    target: 'node22',
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 5000,
  },
  resolve: {
    alias: {
      '@munode/protocol': path.resolve(__dirname, 'packages/protocol/dist/index.js'),
      '@munode/common': path.resolve(__dirname, 'packages/common/dist/index.js'),
      '@munode/hub-server': path.resolve(__dirname, 'packages/hub-server/dist/index.js'),
      '@munode/edge-server': path.resolve(__dirname, 'packages/edge-server/dist/index.js'),
    },
  },
});

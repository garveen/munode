import js from '@eslint/js';
import tsparser from '@typescript-eslint/parser';
import tsplugin from '@typescript-eslint/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: ['./tsconfig.json', './packages/*/tsconfig.json'],
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: globals.node,
    },
    plugins: {
      '@typescript-eslint': tsplugin,
    },
    rules: {
      ...tsplugin.configs.recommended.rules,
      ...tsplugin.configs['recommended-requiring-type-checking'].rules,
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  prettierConfig,
  {
    ignores: ['dist/', 'tmp/', 'node_modules/', 'tests/', 'packages/protocol/src/generated/', '*.js', '*.d.ts', '.eslintrc.cjs', 'vitest.config.unit.ts', 'vitest.config.integration.ts'],
  },
];
import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // Everything here runs where there is no home directory or terminal, so
    // state and transport come in through the ports.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'fs',
            'node:fs',
            'os',
            'node:os',
            'path',
            'node:path',
            'child_process',
            'node:child_process',
            'ws',
            'open',
          ],
          patterns: ['@modelcontextprotocol/*', '@oclif/*', 'fs/*', 'node:fs/*'],
        },
      ],
      // Warnings go through the host's Logger port: a hosted server has no
      // terminal, and stdout carries the stdio MCP protocol.
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'stderr', message: 'Write through the Logger port.' },
        { object: 'process', property: 'stdout', message: 'Write through the Logger port.' },
      ],
    },
  },
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: ['{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}'],
          ignoredDependencies: ['vitest', 'viem', 'tsup', 'tslib'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];

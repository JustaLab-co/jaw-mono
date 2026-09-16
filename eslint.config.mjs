import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // The last three are config files a build tool writes next to the real one
    // and deletes when it finishes. Linting them is a race: `nx affected` runs
    // lint and build together, so eslint reaches a path tsup has already
    // removed and the run fails with ENOENT on a file nobody wrote.
    ignores: [
      '**/dist',
      '**/.next',
      '**/out',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
      '**/tsup.config.bundled_*.mjs',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts', '**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'],
    // Override or add rules here
    rules: {},
  },
];

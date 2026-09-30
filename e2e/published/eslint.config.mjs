import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // The consumer imports the packages as an outside project would, from
    // node_modules, so workspace boundaries do not apply to it.
    files: ['consumer/**'],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
    },
  },
];

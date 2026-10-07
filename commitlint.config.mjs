export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['core', 'wagmi', 'ui', 'cli', 'agent', 'mcp', 'playground', 'demo', 'keys', 'docs', 'release', 'deps', 'ci', 'repo'],
    ],
    'scope-empty': [1, 'never'],
  },
};

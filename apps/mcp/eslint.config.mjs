import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const NO_SESSION_KEY = 'Swap code never signs with the session key: the owner approves the deposit in the wallet.';

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts'],
  },
  {
    files: ['src/swap/**/*.ts', 'src/tools/swap.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^@jaw\\.id/agent(/|$)', allowTypeImports: true, message: NO_SESSION_KEY },
            { regex: '(^|/)(adapters/session-host|connections/disconnect)(\\.[cm]?[jt]s)?$', message: NO_SESSION_KEY },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'Swap code imports statically, so the module rules above can see it.',
        },
        { selector: "MemberExpression[property.name='sessionKey']", message: NO_SESSION_KEY },
        { selector: "Property[key.name='sessionKey']", message: NO_SESSION_KEY },
        { selector: "Literal[value='sessionKey']", message: NO_SESSION_KEY },
      ],
    },
  },
];

export default eslintConfig;

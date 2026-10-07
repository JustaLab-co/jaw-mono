import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(__dirname, '../..'),
  serverExternalPackages: ['postgres', 'oidc-provider'],
  // @jaw.id/agent ships TypeScript source under the workspace condition.
  transpilePackages: ['@jaw.id/agent'],
  webpack: (config) => {
    config.resolve.conditionNames = ['@jaw-mono/source', '...'];
    config.resolve.extensionAlias = { '.js': ['.ts', '.js'] };
    return config;
  },
};

export default nextConfig;

import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(__dirname, '../..'),
  serverExternalPackages: ['postgres'],
};

export default nextConfig;

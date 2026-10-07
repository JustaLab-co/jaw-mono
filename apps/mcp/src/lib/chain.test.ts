import { describe, expect, it } from 'vitest';
import { setTestEnv } from '@/connections/testkit';

setTestEnv();
const { publicClientFor } = await import('./chain');

describe('publicClientFor', () => {
  it('builds a client for the chain the signature was made on, not the configured one', () => {
    expect(publicClientFor(8453).chain?.id).toBe(8453);
    expect(publicClientFor(84532).chain?.id).toBe(84532);
  });

  it('refuses a chain the server does not support', () => {
    expect(() => publicClientFor(1)).toThrow('not supported');
  });
});

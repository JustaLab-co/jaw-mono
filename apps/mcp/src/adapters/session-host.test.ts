import { describe, expect, it, vi } from 'vitest';
import { setTestEnv } from '@/connections/testkit';

setTestEnv();
const { agentLogger } = await import('./session-host');

describe('agentLogger', () => {
  it.each([
    'HTTP request failed.\n\nURL: https://base-sepolia.g.alchemy.com/v2/PROVIDER-KEY\nRequest body: {}',
    'paymaster refused: https://api.justaname.id/proxy/v1/rpc/erc20-paymaster?chainId=84532&api-key=PROVIDER-KEY',
    'socket closed: wss://rpc.example/ws/PROVIDER-KEY',
  ])('never writes a url, and so no key inside one, to the log: %j', (message) => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      agentLogger.warn(message);
      const line = String(out.mock.calls[0][0]);
      expect(line).not.toContain('PROVIDER-KEY');
      expect(line).toContain('<url>');
    } finally {
      out.mockRestore();
    }
  });
});

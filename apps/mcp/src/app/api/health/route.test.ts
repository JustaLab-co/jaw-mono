import { beforeAll, expect, it, vi } from 'vitest';
import { useTestDb } from '@/db/test-db';

beforeAll(useTestDb);

it('reports not ready while the sealing keys are missing, and names the cause in the log only', async () => {
  process.env.JAW_MCP_PUBLIC_URL = 'http://mcp.test';
  process.env.JAW_KEYS_URL = 'http://keys.test';
  delete process.env.JAW_MCP_SEALING_KEYS;
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
  const { GET } = await import('./route');
  const res = await GET(new Request('http://mcp.test/api/health'), { params: Promise.resolve({}) });
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ config: 'invalid' });
  expect(lines.join('\n')).toContain('JAW_MCP_SEALING_KEYS is not set');
});

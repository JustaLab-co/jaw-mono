import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bridge } from '@/connections/bridge';
import { setTestEnv } from '@/connections/testkit';
import { useTestDb } from '@/db/test-db';

setTestEnv();
beforeAll(useTestDb);

const big = 'x'.repeat(200_000);
// A body with no content-length, so the cap has to stop the stream itself.
const streamed = (text: string) =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
const post = (url: string, body: BodyInit) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);

describe('request body caps', () => {
  it('bridge answers 413 without calling the provider', async () => {
    const run = vi.fn();
    for (const body of [big, streamed(big)]) {
      const res = await bridge(post('http://mcp.test/oauth/token', body), run);
      expect(res.status).toBe(413);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('consent answers 413', async () => {
    const { consent } = await import('@/connections/interaction');
    const res = await consent(
      post('http://mcp.test/interaction/abcdefghijklmnop/consent', streamed(big)),
      'abcdefghijklmnop'
    );
    expect(res.status).toBe(413);
  });

  it('the approval decision route answers 413', async () => {
    const { POST } = await import('@/app/api/approvals/[id]/decision/route');
    const res = await POST(post('http://mcp.test/api/approvals/q3L0x7mJ2c1VfN8aYw4p9A/decision', big), {
      params: Promise.resolve({ id: 'q3L0x7mJ2c1VfN8aYw4p9A' }),
    });
    expect(res.status).toBe(413);
  });
});

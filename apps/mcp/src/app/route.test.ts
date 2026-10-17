import { describe, expect, it } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { config } from '@/connections/config';
import { GET, HEAD } from './route';

setTestEnv();

const ctx = { params: Promise.resolve({}) };
const visit = (accept?: string, method = 'GET') =>
  (method === 'HEAD' ? HEAD : GET)(new Request('http://mcp.test/', { method, headers: accept ? { accept } : {} }), ctx);

describe('the root of the server', () => {
  it('given a browser, when it opens the root, then it gets a page naming the MCP endpoint and jaw.id/agents', async () => {
    const res = await visit('text/html,application/xhtml+xml,*/*;q=0.8');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toContain(`href="${config().resource}"`);
    expect(body).toContain('href="https://jaw.id/agents"');
  });

  it('given a client that does not ask for html, when it fetches the root, then it gets the same note as plain text', async () => {
    for (const accept of [undefined, '*/*', 'application/json', 'text/html;q=0, text/plain']) {
      const res = await visit(accept);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      const body = await res.text();
      expect(body).toContain(config().resource);
      expect(body).toContain('https://jaw.id/agents');
      expect(body).not.toContain('<');
    }
  });

  it('answers HEAD with the headers GET would send and no body', async () => {
    const res = await visit('text/html', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toBe('');
  });
});

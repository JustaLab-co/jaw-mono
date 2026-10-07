import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { bridge } from './bridge';

const echo = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.statusCode = 201;
    res.setHeader('set-cookie', ['a=1; path=/x', 'b=2; path=/y']);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body }));
  });
};

describe('bridge', () => {
  it('passes the query exactly as sent, loopback hosts included', async () => {
    const sent = '/oauth/authorize?redirect_uri=http://127.0.0.1:8765/callback&x=%5B%3A%3A1%5D';
    const res = await bridge(new NextRequest(`https://mcp.jaw.id${sent}`), echo);
    expect((await res.json()).url).toBe(sent);
  });

  it('carries the body, method, host and every set-cookie header', async () => {
    const res = await bridge(
      new Request('https://mcp.jaw.id/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token',
      }),
      echo
    );
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie()).toEqual(['a=1; path=/x', 'b=2; path=/y']);
    const seen = await res.json();
    expect(seen).toMatchObject({ method: 'POST', body: 'grant_type=refresh_token' });
    expect(seen.headers).toMatchObject({
      host: 'mcp.jaw.id',
      'x-forwarded-proto': 'https',
      'content-length': '24',
      'content-type': 'application/x-www-form-urlencoded',
    });
  });
});

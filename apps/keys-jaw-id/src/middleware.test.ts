import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from './middleware';

function headersFor(path: string): Headers {
  const request = new NextRequest(`https://keys.jaw.id${path}`);
  return middleware(request).headers;
}

function cspFor(path: string): string {
  return headersFor(path).get('Content-Security-Policy') ?? '';
}

describe('framing policy is route-scoped', () => {
  describe('dialog route "/" — embeddable', () => {
    it('omits frame-ancestors from the CSP', () => {
      expect(cspFor('/')).not.toContain('frame-ancestors');
    });

    it('omits X-Frame-Options', () => {
      expect(headersFor('/').get('X-Frame-Options')).toBeNull();
    });
  });

  describe('/cli-bridge — never embeddable', () => {
    it('keeps frame-ancestors none', () => {
      expect(cspFor('/cli-bridge')).toContain("frame-ancestors 'none'");
    });

    it('keeps X-Frame-Options DENY', () => {
      expect(headersFor('/cli-bridge').get('X-Frame-Options')).toBe('DENY');
    });
  });

  describe('any other route — default deny', () => {
    it.each(['/settings', '/some/future/route', '/dialog'])('%s keeps both deny headers', (path) => {
      expect(cspFor(path)).toContain("frame-ancestors 'none'");
      expect(headersFor(path).get('X-Frame-Options')).toBe('DENY');
    });
  });
});

describe('all other headers stay identical across routes (regression bar)', () => {
  const UNCHANGED_HEADERS = [
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy',
    'X-DNS-Prefetch-Control',
  ] as const;

  it.each(UNCHANGED_HEADERS)('%s matches between "/" and "/cli-bridge"', (header) => {
    const dialog = headersFor('/').get(header);
    const cliBridge = headersFor('/cli-bridge').get(header);

    expect(dialog).not.toBeNull();
    expect(dialog).toBe(cliBridge);
  });

  it('keeps the security baseline values', () => {
    const headers = headersFor('/');
    expect(headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('keeps every other CSP directive identical on the embeddable route', () => {
    const dialogDirectives = new Set(
      cspFor('/')
        .split(';')
        .map((d) => d.trim())
    );
    const otherDirectives = cspFor('/cli-bridge')
      .split(';')
      .map((d) => d.trim())
      .filter((d) => !d.startsWith('frame-ancestors'));

    for (const directive of otherDirectives) {
      // script-src carries a per-request nonce — compare the directive name only
      if (directive.startsWith('script-src')) {
        expect([...dialogDirectives].some((d) => d.startsWith('script-src'))).toBe(true);
        continue;
      }
      // cli-bridge has its own connect-src allowlist by design
      if (directive.startsWith('connect-src')) continue;

      expect(dialogDirectives.has(directive)).toBe(true);
    }
  });
});

describe('/a/[id], the short owner link', () => {
  const PATH = '/a/AQEBAQEBAQEBAQEBAQEBAQ';
  const directive = (path: string, name: string) =>
    cspFor(path)
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(name));

  it('has the same connect-src as /cli-bridge, so the relay socket is allowed', () => {
    expect(directive(PATH, 'connect-src')).toBe(directive('/cli-bridge', 'connect-src'));
    expect(directive(PATH, 'connect-src')).toContain('wss://relay.jaw.id');
    expect(directive('/about', 'connect-src')).not.toContain('wss://relay.jaw.id');
  });

  it('is never embeddable', () => {
    expect(cspFor(PATH)).toContain("frame-ancestors 'none'");
    expect(headersFor(PATH).get('X-Frame-Options')).toBe('DENY');
  });

  it('sends no referrer, is not indexed and is not cached', () => {
    const headers = headersFor(PATH);
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('X-Robots-Tag')).toBe('noindex');
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  it('sends no referrer from the blob endpoint either', () => {
    expect(headersFor('/api/a/AQEBAQEBAQEBAQEBAQEBAQ').get('Referrer-Policy')).toBe('no-referrer');
  });

  it('leaves other routes on the default referrer policy', () => {
    expect(headersFor('/about').get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headersFor('/a').get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headersFor('/cli-bridge').get('X-Robots-Tag')).toBeNull();
    expect(headersFor('/cli-bridge').get('Cache-Control')).toBeNull();
  });
});

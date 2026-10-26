import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { setTestEnv } from '@/connections/testkit';
import { reasonOf } from './reply';

setTestEnv();
// The key has characters that url-encoding changes, so the encoded form is distinct from the bare one.
const SECRET = 'sk_live/s3cr3t@x';
process.env.JAW_MCP_API_KEY = SECRET;

describe('reasonOf', () => {
  it('given an answer of the wrong shape, then it says so', () => {
    const shape = z.object({ ok: z.boolean() }).safeParse({ ok: 'yes' });
    expect(shape.success).toBe(false);
    expect(reasonOf(shape.error)).toBe('The proxy answered with an unexpected shape.');
  });

  it('given an error, then it is its message', () => {
    expect(reasonOf(new Error('the proxy timed out'))).toBe('the proxy timed out');
  });

  it('given something with no message, then the request failed', () => {
    expect(reasonOf(undefined)).toBe('request failed');
    expect(reasonOf('boom')).toBe('request failed');
  });

  it('given a message that quotes the api key, then the key is not in it', () => {
    const reason = reasonOf(
      new Error(`GET https://proxy.test/?api-key=${encodeURIComponent(SECRET)} failed with ${SECRET}`)
    );
    expect(reason).not.toContain(SECRET);
    expect(reason).not.toContain(encodeURIComponent(SECRET));
    expect(reason).toBe('GET https://proxy.test/?api-key=[key] failed with [key]');
  });

  it('given a long message over two lines, then it is one line, cut after 200 characters and saying so', () => {
    const reason = reasonOf(new Error(`first\nsecond ${'x'.repeat(400)}`));
    expect(reason).not.toContain('\n');
    expect(reason.startsWith('first\uFFFDsecond x')).toBe(true);
    expect(reason.endsWith('\u2026 (213 more characters)')).toBe(true);
  });
});

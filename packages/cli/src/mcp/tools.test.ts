import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { supportsSessionMode } from '../lib/rpc-classifier.js';
import { payAndFetchSchema, rpcMethodSchema } from '@jaw.id/agent';

describe('payAndFetch url schema', () => {
  const url = z.object(payAndFetchSchema).shape.url;

  it('accepts http and https', () => {
    expect(url.safeParse('https://api.example.com/x').success).toBe(true);
    expect(url.safeParse('http://localhost:8080/x').success).toBe(true);
  });

  it('rejects non-fetch schemes that would otherwise reach fetch()', () => {
    for (const bad of [
      'file:///etc/passwd',
      'data:text/plain,hello',
      'javascript:alert(1)',
      'ftp://x.com',
      'not a url',
      '',
    ]) {
      expect(url.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('rpc chainId schema', () => {
  const chainId = z.object(rpcMethodSchema).shape.chainId;

  it('accepts positive integers', () => {
    expect(chainId.safeParse(1).success).toBe(true);
    expect(chainId.safeParse(8453).success).toBe(true);
  });

  it('rejects NaN, Infinity, floats, zero, and negatives', () => {
    for (const bad of [NaN, Infinity, -Infinity, 8453.5, 0, -1]) {
      expect(chainId.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

/**
 * The `.describe()` ships in the tool schema, so it is the list the model reads.
 * A method named here that session mode refuses is a dead end the model walks
 * into with `session: true`.
 */
describe('rpc session description', () => {
  const description = z.object(rpcMethodSchema).shape.session.description ?? '';

  const listed = (() => {
    const match = /Supported methods only: ([^.]+)\./.exec(description);
    if (!match) return null;
    return match[1]
      .split(/,| and /)
      .map((m) => m.trim())
      .filter(Boolean);
  })();

  it('lists exactly what session mode accepts', () => {
    expect(listed).not.toBeNull();
    for (const method of [
      'eth_requestAccounts',
      'eth_accounts',
      'wallet_sendCalls',
      'wallet_getCallsStatus',
      'personal_sign',
      'eth_signTypedData_v4',
      'wallet_sign',
      'eth_sendTransaction',
      'wallet_connect',
      'wallet_grantPermissions',
      'wallet_revokePermissions',
    ]) {
      expect(listed?.includes(method), method).toBe(supportsSessionMode(method));
    }
  });

  it('says where the signing methods go instead of just leaving them out', () => {
    // Absent from the list is not enough: the model still guesses.
    expect(description).toMatch(/personal_sign[^.]*eth_signTypedData_v4[^.]*browser\s+only/);
  });
});

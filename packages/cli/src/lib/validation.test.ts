import { describe, it, expect } from 'vitest';
import { isValidKeysUrl, isValidRelayUrl, parsePermissionsConfig, isSafeApiKey } from './validation.js';

describe('validation', () => {
  describe('isValidKeysUrl', () => {
    it('accepts https *.jaw.id', () => {
      expect(isValidKeysUrl('https://keys.jaw.id')).toBe(true);
      expect(isValidKeysUrl('https://staging.keys.jaw.id')).toBe(true);
    });
    it('accepts https jaw.id', () => {
      expect(isValidKeysUrl('https://jaw.id')).toBe(true);
    });
    it('accepts localhost (http)', () => {
      expect(isValidKeysUrl('http://localhost:3000')).toBe(true);
    });
    it('accepts 127.0.0.1 (http)', () => {
      expect(isValidKeysUrl('http://127.0.0.1:3000')).toBe(true);
    });
    it('rejects untrusted domain', () => {
      expect(isValidKeysUrl('https://evil.com')).toBe(false);
    });
    it('rejects http for non-localhost', () => {
      expect(isValidKeysUrl('http://keys.jaw.id')).toBe(false);
    });
    it('rejects invalid URL', () => {
      expect(isValidKeysUrl('not-a-url')).toBe(false);
    });
  });

  describe('parsePermissionsConfig', () => {
    const validAddr = '0x1234567890123456789012345678901234567890';

    it('accepts valid calls-only permissions', () => {
      const result = parsePermissionsConfig({
        calls: [{ target: validAddr, selector: '0xa9059cbb' }],
      });
      expect(result.calls).toHaveLength(1);
    });

    it('accepts valid spends-only permissions', () => {
      const result = parsePermissionsConfig({
        spends: [{ token: validAddr, allowance: '0x1000', unit: 'day' }],
      });
      expect(result.spends).toHaveLength(1);
    });

    it('accepts calls + spends together', () => {
      const result = parsePermissionsConfig({
        calls: [{ target: validAddr }],
        spends: [{ token: validAddr, allowance: '0x1000', unit: 'day', multiplier: 2 }],
      });
      expect(result.calls).toHaveLength(1);
      expect(result.spends).toHaveLength(1);
    });

    it('rejects empty object (no calls or spends)', () => {
      expect(() => parsePermissionsConfig({})).toThrow('Invalid permissions');
    });

    it('rejects empty calls array', () => {
      expect(() => parsePermissionsConfig({ calls: [] })).toThrow('Invalid permissions');
    });

    it('rejects empty spends array', () => {
      expect(() => parsePermissionsConfig({ spends: [] })).toThrow('Invalid permissions');
    });

    it('rejects invalid target address', () => {
      expect(() => parsePermissionsConfig({ calls: [{ target: 'bad' }] })).toThrow('Invalid permissions');
    });

    it('rejects invalid selector (not 4 bytes)', () => {
      expect(() => parsePermissionsConfig({ calls: [{ target: validAddr, selector: '0xaa' }] })).toThrow(
        '4-byte hex selector'
      );
    });

    it('rejects invalid spend unit', () => {
      expect(() =>
        parsePermissionsConfig({ spends: [{ token: validAddr, allowance: '0x1000', unit: 'decade' }] })
      ).toThrow('Invalid permissions');
    });

    it('rejects an allowance that is neither decimal nor hex', () => {
      expect(() =>
        parsePermissionsConfig({ spends: [{ token: validAddr, allowance: 'not-hex', unit: 'day' }] })
      ).toThrow('Invalid permissions');
    });

    it('rejects empty hex allowance (0x)', () => {
      expect(() => parsePermissionsConfig({ spends: [{ token: validAddr, allowance: '0x', unit: 'day' }] })).toThrow(
        'decimal or 0x hex integer'
      );
    });

    // The SDK feeds allowance to BigInt(), which takes both forms, and the
    // permissions doc shows the decimal one. Rejecting decimal here made the
    // documented example fail against the CLI.
    it('accepts a decimal allowance, matching the SDK and the docs', () => {
      const parsed = parsePermissionsConfig({
        spends: [{ token: validAddr, allowance: '10000000', unit: 'day' }],
      });
      expect(parsed.spends?.[0].allowance).toBe('10000000');
    });

    it('still accepts a hex allowance', () => {
      const parsed = parsePermissionsConfig({
        spends: [{ token: validAddr, allowance: '0x989680', unit: 'day' }],
      });
      expect(parsed.spends?.[0].allowance).toBe('0x989680');
    });

    it('rejects a signed or fractional allowance', () => {
      for (const allowance of ['-1', '1.5', '1e6']) {
        expect(() => parsePermissionsConfig({ spends: [{ token: validAddr, allowance, unit: 'day' }] })).toThrow(
          'decimal or 0x hex integer'
        );
      }
    });

    it('rejects non-object input', () => {
      expect(() => parsePermissionsConfig('not an object')).toThrow('Invalid permissions');
    });
  });

  describe('isValidRelayUrl', () => {
    it('accepts wss *.jaw.id', () => {
      expect(isValidRelayUrl('wss://relay.jaw.id')).toBe(true);
      expect(isValidRelayUrl('wss://staging.relay.jaw.id')).toBe(true);
    });
    it('accepts ws localhost', () => {
      expect(isValidRelayUrl('ws://localhost:8080')).toBe(true);
    });
    it('accepts ws 127.0.0.1', () => {
      expect(isValidRelayUrl('ws://127.0.0.1:8080')).toBe(true);
    });
    it('rejects ws for non-localhost', () => {
      expect(isValidRelayUrl('ws://relay.jaw.id')).toBe(false);
    });
    it('rejects untrusted domain', () => {
      expect(isValidRelayUrl('wss://evil.com')).toBe(false);
    });
    it('rejects http/https scheme', () => {
      expect(isValidRelayUrl('https://relay.jaw.id')).toBe(false);
    });
    it('rejects invalid URL', () => {
      expect(isValidRelayUrl('not-a-url')).toBe(false);
    });
  });
});

// The key is concatenated into a query string by every consumer, without
// encoding, so what must be rejected is anything that changes the meaning of
// the URL around it rather than anything that fails a guessed format.
describe('isSafeApiKey', () => {
  it('accepts what a key looks like', () => {
    expect(isSafeApiKey('jaw_live_9f2a8c1d4e')).toBe(true);
    expect(isSafeApiKey('ABC-123_xyz.~')).toBe(true);
  });

  it('rejects anything that would rewrite the query it lands in', () => {
    // `...&api-key=x&chainId=1` and the chain silently changed.
    expect(isSafeApiKey('x&chainId=1')).toBe(false);
    expect(isSafeApiKey('x#frag')).toBe(false);
    expect(isSafeApiKey('x?y=z')).toBe(false);
    expect(isSafeApiKey('has space')).toBe(false);
    expect(isSafeApiKey('a/b')).toBe(false);
  });

  it('rejects an empty one, which is not a key', () => {
    expect(isSafeApiKey('')).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';

// Stub core (only used by the chainId branch these cases don't touch).
vi.mock('@jaw.id/core', () => ({ SUPPORTED_CHAINS: [] }));

import { formatValue } from './Eip712Tree';

const MAX_U256 = (2n ** 256n - 1n).toString();

describe('formatValue — a start date is not a warning', () => {
  const twoDaysAgo = String(Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60);

  it('shows a start in the past as a plain date', () => {
    for (const name of ['validAfter', 'notBefore']) {
      const leaf = formatValue('uint256', twoDaysAgo, name);
      expect(leaf.copyValue, name).toBe(twoDaysAgo);
      expect(leaf.tone, name).toBeUndefined();
      expect(leaf.note, name).toBeUndefined();
    }
  });

  it('still warns on a deadline in the past', () => {
    expect(formatValue('uint256', twoDaysAgo, 'validBefore')).toMatchObject({
      tone: 'expired',
      note: 'This date is in the past.',
    });
  });

  it('shows a start of 0 as "Immediately", not the number 0', () => {
    const leaf = formatValue('uint256', '0', 'validAfter');
    expect(leaf.text).toBe('Immediately');
    expect(leaf.tone).toBeUndefined();
  });

  it('keeps a deadline of 0 as it was: never "Immediately"', () => {
    expect(formatValue('uint256', '0', 'validBefore').text).toBe('0');
  });
});

describe('formatValue — amount name heuristic', () => {
  it('labels max-uint as "Unlimited" for shares/qty fields, not just amount/value', () => {
    expect(formatValue('uint256', MAX_U256, 'shares')).toMatchObject({ text: 'Unlimited', tone: 'far' });
    expect(formatValue('uint256', MAX_U256, 'qty')).toMatchObject({ text: 'Unlimited', tone: 'far' });
  });

  it('groups a normal shares value instead of flagging it', () => {
    expect(formatValue('uint256', '1500', 'shares').text).toBe('1,500');
  });
});

describe('formatValue — date leaf keeps the raw integer to copy', () => {
  it('exposes the unix integer as copyValue behind the formatted date', () => {
    const leaf = formatValue('uint256', '1893456000', 'deadline'); // 2030-01-01
    expect(leaf.copyValue).toBe('1893456000');
    // Visible text is a derived date, not the bare integer.
    expect(leaf.text).not.toBe('1893456000');
  });

  it('does not attach a copyValue to a plain grouped amount (no derived form to reveal)', () => {
    expect(formatValue('uint256', '1500', 'shares').copyValue).toBeUndefined();
  });
});

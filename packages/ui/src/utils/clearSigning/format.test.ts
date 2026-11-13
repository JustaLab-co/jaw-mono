import { describe, expect, it, vi } from 'vitest';

// Stub core (only needed for the on-chain resolver we don't invoke — tests inject
// `resolveToken` via ctx) so the suite stays hermetic.
vi.mock('@jaw.id/core', () => ({ JAW_RPC_URL: {}, SUPPORTED_CHAINS: [] }));

import { applyFormat } from './format';

/* eslint-disable @typescript-eslint/no-explicit-any */

const USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';

// Permit-style field: tokenPath `@.to` never resolves in typed-data, exercising the
// verifyingContract fallback.
const amountField = { path: 'value', label: 'Amount', format: 'tokenAmount', params: { tokenPath: '@.to' } };

const baseCtx = () => ({
  args: { value: '1000000' },
  tx: { verifyingContract: USDC },
  chainId: 10,
  resolveToken: async (address: string) => ({ address, decimals: 6, symbol: 'USDC' }),
});

describe('applyFormat — verifyingContract token fallback (P2#7 opt-in gate)', () => {
  it('denominates against the verifyingContract when the descriptor opts in via metadata.token', async () => {
    const descriptor = { context: {}, metadata: { token: { ticker: 'USDC', decimals: 6 } } } as any;
    const format = { fields: [amountField] } as any;

    const out = await applyFormat(descriptor, format, baseCtx() as any);
    if (!out) throw new Error('expected a clear-signing display');
    const row = out.rows[0];
    expect(row.kind).toBe('tokenAmount');
    expect(row.value).toBe('1'); // 1_000_000 / 1e6
    expect(row.symbol).toBe('USDC');
    expect(row.tokenAddress).toBe(USDC);
  });

  it('renders raw and never reads a token when the descriptor omits metadata.token', async () => {
    const descriptor = { context: {}, metadata: { owner: 'USD Coin' } } as any;
    const format = { fields: [amountField] } as any;
    const resolveToken = vi.fn(async (address: string) => ({ address, decimals: 6, symbol: 'USDC' }));

    const out = await applyFormat(descriptor, format, { ...baseCtx(), resolveToken } as any);
    if (!out) throw new Error('expected a clear-signing display');
    const row = out.rows[0];
    expect(row.kind).toBe('raw');
    expect(row.value).toBe('1000000');
    expect(row.symbol).toBeUndefined();
    // Gate short-circuits before any on-chain read.
    expect(resolveToken).not.toHaveBeenCalled();
  });
});

describe('applyFormat — max-uint tokenAmount renders "Unlimited"', () => {
  const MAX_U256 = (2n ** 256n - 1n).toString();
  const MAX_U160 = (2n ** 160n - 1n).toString();

  it('shows "Unlimited" (with symbol) instead of a 78-digit number when the token resolves', async () => {
    const descriptor = { context: {}, metadata: { token: { ticker: 'USDC', decimals: 6 } } } as any;
    const format = { fields: [amountField] } as any;

    const out = await applyFormat(descriptor, format, { ...baseCtx(), args: { value: MAX_U256 } } as any);
    if (!out) throw new Error('expected a clear-signing display');
    expect(out.rows[0].value).toBe('Unlimited');
    expect(out.rows[0].symbol).toBe('USDC');
    expect(out.rows[0].kind).toBe('tokenAmount');
  });

  it('shows "Unlimited" (kind tokenAmount, so it keeps the warning treatment) even when no token resolves', async () => {
    const descriptor = { context: {}, metadata: { owner: 'x' } } as any;
    const format = { fields: [amountField] } as any;

    const out = await applyFormat(descriptor, format, { ...baseCtx(), args: { value: MAX_U160 } } as any);
    if (!out) throw new Error('expected a clear-signing display');
    expect(out.rows[0].value).toBe('Unlimited');
    // Not demoted to 'raw' — otherwise the UI renders plain white text with no amber ⚠.
    expect(out.rows[0].kind).toBe('tokenAmount');
  });
});

describe('applyFormat — MappingFailure', () => {
  it('renders a scalar field into a row (positive: no failure)', async () => {
    const descriptor = { context: {} } as any;
    const format = { fields: [{ path: 'nonce', label: 'Nonce' }] } as any;
    const ctx = { args: { nonce: '7' }, tx: {}, chainId: 1 } as any;

    const out = await applyFormat(descriptor, format, ctx);
    if (!out) throw new Error('expected a clear-signing display');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].value).toBe('7');
  });

  it('aborts the whole descriptor (returns null) when a field maps to a non-scalar struct', async () => {
    const descriptor = { context: {} } as any;
    const format = { fields: [{ path: 'details', label: 'Details' }] } as any;
    // `details` is a struct — a flat row can't hold it, so the descriptor is abandoned.
    const ctx = { args: { details: { token: USDC, amount: '1' } }, tx: {}, chainId: 1 } as any;

    const out = await applyFormat(descriptor, format, ctx);
    expect(out).toBeNull();
  });
});

describe('applyFormat — start dates', () => {
  // Circle's EIP-3009 descriptor in the ERC-7730 registry: both bounds are dates.
  const format = {
    fields: [
      { path: 'validAfter', label: 'Valid after', format: 'date', params: { encoding: 'timestamp' } },
      { path: 'validBefore', label: 'Valid before', format: 'date', params: { encoding: 'timestamp' } },
    ],
  } as any;
  const ctx = (validAfter: string, validBefore: string) =>
    ({ args: { validAfter, validBefore }, tx: {}, chainId: 8453 }) as any;

  it('marks the start as a start and leaves the deadline a deadline', async () => {
    const out = await applyFormat({ context: {} } as any, format, ctx('1762800000', '1762900000'));
    if (!out) throw new Error('expected a clear-signing display');
    expect(out.rows[0]).toMatchObject({
      label: 'Valid after',
      kind: 'date',
      rawValue: '1762800000',
      dateKind: 'start',
    });
    expect(out.rows[1]).toMatchObject({ label: 'Valid before', kind: 'date', rawValue: '1762900000' });
    expect(out.rows[1].dateKind).not.toBe('start');
  });

  it('shows a start of 0 as "Immediately" rather than 1 Jan 1970', async () => {
    const out = await applyFormat({ context: {} } as any, format, ctx('0', '1762900000'));
    if (!out) throw new Error('expected a clear-signing display');
    expect(out.rows[0]).toMatchObject({ label: 'Valid after', value: 'Immediately' });
    expect(out.rows[0].kind).not.toBe('date');
  });

  it('keeps a deadline of 0 a date, so it is still flagged as past', async () => {
    const out = await applyFormat({ context: {} } as any, format, ctx('0', '0'));
    if (!out) throw new Error('expected a clear-signing display');
    expect(out.rows[1]).toMatchObject({ label: 'Valid before', kind: 'date', rawValue: '0' });
  });
});

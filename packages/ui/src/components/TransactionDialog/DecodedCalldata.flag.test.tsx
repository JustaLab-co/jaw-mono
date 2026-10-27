// @vitest-environment jsdom
// The amber allowance flag inside the calldata card. It comes from the local decode and shows once
// the lookup has read the call, as decoded params or a clear-signed view; while it loads, or when it
// cannot read the call, there is no flag.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { maxUint160, maxUint256 } from 'viem';

import { clearAddressIdentityCache } from '../../utils/addressIdentity';
import type { DecodeResult } from '../../hooks/useDecodedCalldata';
import type { AllowanceFlag } from '../../utils/allowances';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../TokenIcon', () => ({ TokenIcon: () => null }));
vi.mock('../IdentityAvatar', () => ({ IdentityAvatar: () => null }));
vi.mock('../VerificationDigest', () => ({ DigestRow: () => null }));

import { DecodedCalldataView } from './DecodedCalldata';

const SPENDER = '0x1111111111111111111111111111111111111111';
const MAX = maxUint256.toString();

const spenderParam = { name: 'spender', type: 'address', value: SPENDER, rawValue: SPENDER };
const approveOf = (amount: bigint): DecodeResult => ({
  clearSigned: null,
  isLoading: false,
  decoded: {
    functionName: 'approve',
    signature: 'approve(address, uint256)',
    params: [spenderParam, { name: 'amount', type: 'uint256', value: amount.toString() }],
  },
});
const approveDecode = approveOf(maxUint256);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearAddressIdentityCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 }))
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function show(decode: DecodeResult, allowanceFlag: AllowanceFlag | null) {
  act(() => {
    root.render(
      createElement(DecodedCalldataView, {
        to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        data: '0x095ea7b3',
        chainId: 8453,
        mainnetRpcUrl: 'https://rpc.test/mainnet',
        decode,
        allowanceFlag,
      })
    );
  });
}
const text = () => container.textContent ?? '';
const count = (needle: string) => text().split(needle).length - 1;

describe('DecodedCalldataView allowance flag', () => {
  it('shows Unlimited in place of the flagged amount, and keeps the spender', () => {
    show(approveDecode, { label: 'Unlimited', argIndex: 1, amount: maxUint256 });
    expect(count('Unlimited')).toBe(1);
    expect(text()).not.toContain(MAX);
    expect(text()).toContain(SPENDER);
  });

  it.each([
    [
      'Unlimited',
      { label: 'Unlimited', argIndex: 1, amount: maxUint256 } as AllowanceFlag,
      'Lets the spender take any amount of this token, now or later.',
    ],
    [
      'All tokens',
      { label: 'All tokens', argIndex: 1 } as AllowanceFlag,
      'Lets the operator move every token in this collection, now or later.',
    ],
  ])('opens the note on %s from the keyboard, keeping the visible word as its name', async (_, flag, note) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
    );
    show(approveDecode, flag);
    const trigger = container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]');
    expect(trigger?.tabIndex).toBe(0);
    expect(trigger?.getAttribute('aria-label')).toBeNull();
    expect(trigger?.textContent).toBe(flag.label);
    expect(document.body.textContent).not.toContain(note);

    await act(async () => trigger?.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));

    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(note);
    expect(trigger?.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('puts the flag on the argument the decoder names, not always the second', () => {
    const permit: DecodeResult = {
      ...approveDecode,
      decoded: {
        functionName: 'permit',
        signature: 'permit(address, address, uint256, uint256, uint8, bytes32, bytes32)',
        params: [
          { name: 'owner', type: 'address', value: SPENDER, rawValue: SPENDER },
          { name: 'spender', type: 'address', value: SPENDER, rawValue: SPENDER },
          { name: 'value', type: 'uint256', value: MAX },
          { name: 'deadline', type: 'uint256', value: '1900000000' },
        ],
      },
    };
    show(permit, { label: 'Unlimited', argIndex: 2, amount: maxUint256 });
    expect(count('Unlimited')).toBe(1);
    expect(text()).not.toContain(MAX);
    expect(text()).toContain('1900000000');
  });

  it('shows All tokens for an approval of a whole collection', () => {
    const setAll: DecodeResult = {
      ...approveDecode,
      decoded: {
        functionName: 'setApprovalForAll',
        signature: 'setApprovalForAll(address, bool)',
        params: [
          { name: 'operator', type: 'address', value: SPENDER, rawValue: SPENDER },
          { name: 'approved', type: 'bool', value: 'true' },
        ],
      },
    };
    show(setAll, { label: 'All tokens', argIndex: 1 });
    expect(text()).toContain('All tokens');
    expect(text()).not.toContain('Unlimited');
  });

  it.each([
    ['max uint256', maxUint256],
    ['max uint160', maxUint160],
  ])('shows Unlimited in place of an amount of exactly %s', (_, amount) => {
    show(approveOf(amount), { label: 'Unlimited', argIndex: 1, amount });
    expect(count('Unlimited')).toBe(1);
    expect(text()).not.toContain(amount.toString());
  });

  it('keeps any other flagged amount visible, with the flag beside it', () => {
    // Not a max amount, so the user still sees the number it stands for.
    const amount = 1n << 200n;
    show(approveOf(amount), { label: 'Unlimited', argIndex: 1, amount });
    expect(count('Unlimited')).toBe(1);
    expect(text()).toContain(amount.toString());
  });

  it('keeps an amount the lookup read as another number, and puts the flag on top instead', () => {
    show(approveOf(1_234_567n), { label: 'Unlimited', argIndex: 1, amount: maxUint256 });
    expect(count('Unlimited')).toBe(1);
    expect(text()).toContain('1234567');
  });

  it('shows Unlimited in place of an allowed flag that is true, and keeps one that is not', () => {
    const daiPermit = (allowed: string): DecodeResult => ({
      ...approveDecode,
      decoded: {
        functionName: 'permit',
        signature: 'permit(address, address, uint256, uint256, bool, uint8, bytes32, bytes32)',
        params: [
          { name: 'holder', type: 'address', value: SPENDER, rawValue: SPENDER },
          { name: 'spender', type: 'address', value: SPENDER, rawValue: SPENDER },
          { name: 'nonce', type: 'uint256', value: '3' },
          { name: 'expiry', type: 'uint256', value: '1900000000' },
          { name: 'allowed', type: 'bool', value: allowed },
        ],
      },
    });
    const flag: AllowanceFlag = { label: 'Unlimited', argIndex: 4, amount: maxUint256 };
    show(daiPermit('true'), flag);
    expect(count('Unlimited')).toBe(1);
    expect(text()).not.toContain('true');
    show(daiPermit('false'), flag);
    expect(count('Unlimited')).toBe(1);
    expect(text()).toContain('false');
  });

  it('shows the flag on top when the decoded params have no argument at its index', () => {
    const short: DecodeResult = {
      ...approveDecode,
      decoded: { functionName: 'approve', signature: 'approve(address)', params: [spenderParam] },
    };
    show(short, { label: 'Unlimited', argIndex: 1 });
    expect(count('Unlimited')).toBe(1);
  });

  it('keeps a value the lookup read as something else, and puts the flag on top instead', () => {
    const OTHER = '0x3333333333333333333333333333333333333333';
    const otherShape: DecodeResult = {
      ...approveDecode,
      decoded: {
        functionName: 'route',
        signature: 'route(address, address)',
        params: [spenderParam, { name: 'to', type: 'address', value: OTHER, rawValue: OTHER }],
      },
    };
    show(otherShape, { label: 'Unlimited', argIndex: 1, amount: maxUint256 });
    expect(count('Unlimited')).toBe(1);
    expect(text()).toContain(OTHER);
  });

  it('shows the full number when the call is not flagged, even at max uint256', () => {
    show(approveDecode, null);
    expect(text()).toContain(MAX);
    expect(text()).not.toContain('Unlimited');
  });

  it('shows no flag while the calldata lookup is still loading', () => {
    show({ clearSigned: null, decoded: null, isLoading: true }, { label: 'Unlimited', argIndex: 1 });
    expect(text()).not.toContain('Unlimited');
  });

  it('shows no flag when the calldata lookup could not read the call', () => {
    show({ clearSigned: null, decoded: null, isLoading: false }, { label: 'Unlimited', argIndex: 1 });
    expect(text()).not.toContain('Unlimited');
  });

  it('shows the flag over a clear-signed view that has no amount to put it on', () => {
    const clearSigned: DecodeResult = {
      ...approveDecode,
      clearSigned: {
        intent: 'Approve operator',
        rows: [{ label: 'Operator', value: SPENDER, rawValue: SPENDER, kind: 'address' }],
      },
    };
    show(clearSigned, { label: 'All tokens', argIndex: 1 });
    expect(count('All tokens')).toBe(1);
  });

  it('keeps All tokens over a clear-signed view whose only large amount is another row', () => {
    const clearSigned: DecodeResult = {
      ...approveDecode,
      decoded: null,
      clearSigned: {
        intent: 'Approve operator',
        rows: [{ label: 'Fee', value: MAX, rawValue: MAX, kind: 'tokenAmount', symbol: 'USDC' }],
      },
    };
    show(clearSigned, { label: 'All tokens', argIndex: 1 });
    expect(count('All tokens')).toBe(1);
  });

  it('shows Unlimited once on a clear-signed view that already flags its amount', () => {
    const clearSigned: DecodeResult = {
      ...approveDecode,
      decoded: null,
      clearSigned: {
        intent: 'Approve',
        rows: [{ label: 'Amount', value: MAX, rawValue: MAX, kind: 'tokenAmount', symbol: 'USDC' }],
      },
    };
    show(clearSigned, { label: 'Unlimited', argIndex: 1, amount: maxUint256 });
    expect(count('Unlimited')).toBe(1);
  });

  it('shows Unlimited once on a clear-signed approve of exactly max uint160', () => {
    const max160 = maxUint160.toString();
    const clearSigned: DecodeResult = {
      ...approveDecode,
      decoded: null,
      clearSigned: {
        intent: 'Approve',
        rows: [{ label: 'Amount', value: max160, rawValue: max160, kind: 'tokenAmount', symbol: 'USDC' }],
      },
    };
    show(clearSigned, { label: 'Unlimited', argIndex: 1, amount: maxUint160 });
    expect(count('Unlimited')).toBe(1);
  });

  it('shows Unlimited once on a clear-signed approve of 2^255, which the view prints as a number', () => {
    const floor = (1n << 255n).toString();
    const clearSigned: DecodeResult = {
      ...approveDecode,
      decoded: null,
      clearSigned: {
        intent: 'Approve',
        rows: [{ label: 'Amount', value: floor, rawValue: floor, kind: 'tokenAmount', symbol: 'USDC' }],
      },
    };
    show(clearSigned, { label: 'Unlimited', argIndex: 1, amount: 1n << 255n });
    expect(count('Unlimited')).toBe(1);
  });

  it('keeps the flag on top when the unlimited row the view shows is not the approved amount', () => {
    const floor = (1n << 255n).toString();
    const clearSigned: DecodeResult = {
      ...approveDecode,
      decoded: null,
      clearSigned: {
        intent: 'Approve',
        rows: [
          { label: 'Amount', value: floor, rawValue: floor, kind: 'tokenAmount', symbol: 'USDC' },
          { label: 'Fee', value: MAX, rawValue: MAX, kind: 'tokenAmount', symbol: 'USDC' },
        ],
      },
    };
    show(clearSigned, { label: 'Unlimited', argIndex: 1, amount: 1n << 255n });
    expect(count('Unlimited')).toBe(2);
  });

  it('prints a clear-signed amount of 2^255 that is no allowance as a number', () => {
    const floor = (1n << 255n).toString();
    const clearSigned: DecodeResult = {
      ...approveDecode,
      decoded: null,
      clearSigned: {
        intent: 'Send',
        rows: [{ label: 'Amount', value: floor, rawValue: floor, kind: 'tokenAmount', symbol: 'USDC' }],
      },
    };
    show(clearSigned, null);
    expect(text()).not.toContain('Unlimited');
  });
});

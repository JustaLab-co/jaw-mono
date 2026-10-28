// @vitest-environment jsdom
// A collapsed call or batch step still carries the amber allowance flag in its header, so an
// unlimited approval is seen without opening it. Only a call the lookup could read is flagged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { DecodeResult } from '../../hooks/useDecodedCalldata';

const decodedApprove: DecodeResult = {
  clearSigned: null,
  isLoading: false,
  decoded: {
    functionName: 'approve',
    signature: 'approve(address, uint256)',
    params: [
      { name: 'spender', type: 'address', value: '0x1111111111111111111111111111111111111111' },
      { name: 'amount', type: 'uint256', value: '1' },
    ],
  },
};
const loading: DecodeResult = { clearSigned: null, decoded: null, isLoading: true };
const unreadable: DecodeResult = { clearSigned: null, decoded: null, isLoading: false };
let lookup: DecodeResult = decodedApprove;
vi.mock('../../hooks/useDecodedCalldata', () => ({ useDecodedCalldata: () => lookup }));
vi.mock('../../hooks/useAddressIdentities', () => ({ useAddressIdentity: () => null }));

import { Accordion } from '../ui/accordion';
import { BatchStep, SingleCallData } from './CallSections';
import type { AllowanceFlag } from '../../utils/allowances';

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DATA = '0x095ea7b3';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  lookup = decodedApprove;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function showStep(allowanceFlag: AllowanceFlag | null) {
  act(() => {
    root.render(
      createElement(
        Accordion,
        { type: 'multiple' },
        createElement(BatchStep, {
          transaction: { to: TOKEN, data: DATA, chainId: 8453 },
          index: 0,
          nativeSymbol: 'ETH',
          nativeTokenPrice: 0,
          mainnetRpcUrl: 'https://rpc.test/mainnet',
          allowanceFlag,
        })
      )
    );
  });
}

function showSingle(allowanceFlag: AllowanceFlag | null) {
  act(() => {
    root.render(
      createElement(
        Accordion,
        { type: 'single', collapsible: true },
        createElement(SingleCallData, {
          to: TOKEN,
          data: DATA,
          decode: lookup,
          chainId: 8453,
          mainnetRpcUrl: 'https://rpc.test/mainnet',
          allowanceFlag,
        })
      )
    );
  });
}

const header = () => container.querySelector('button')?.textContent ?? '';

describe('allowance flag on a collapsed call', () => {
  it('shows Unlimited in the header of a collapsed batch step', () => {
    showStep({ label: 'Unlimited', argIndex: 1 });
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(header()).toContain('Unlimited');
  });

  it('keeps the header flag plain, with no hover note inside the button that opens the step', () => {
    showStep({ label: 'Unlimited', argIndex: 1 });
    expect(container.querySelector('button [data-slot="tooltip-trigger"], button [tabindex]')).toBeNull();
  });

  it('shows All tokens in the header of a collapsed batch step', () => {
    showStep({ label: 'All tokens', argIndex: 1 });
    expect(header()).toContain('All tokens');
  });

  it('shows no flag on a batch step that grants no unlimited allowance', () => {
    showStep(null);
    expect(header()).not.toContain('Unlimited');
    expect(header()).not.toContain('All tokens');
  });

  it('shows Unlimited in the header of a collapsed single call', () => {
    showSingle({ label: 'Unlimited', argIndex: 1 });
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(header()).toContain('Unlimited');
  });

  it.each([
    ['still loading', loading],
    ['unable to read the call', unreadable],
  ])('shows no flag on a batch step while the lookup is %s', (_, state) => {
    lookup = state;
    showStep({ label: 'Unlimited', argIndex: 1 });
    expect(header()).not.toContain('Unlimited');
  });

  it.each([
    ['still loading', loading],
    ['unable to read the call', unreadable],
  ])('shows no flag on a single call while the lookup is %s', (_, state) => {
    lookup = state;
    showSingle({ label: 'Unlimited', argIndex: 1 });
    expect(header()).not.toContain('Unlimited');
  });

  it('shows no flag on a single call that grants no unlimited allowance', () => {
    showSingle(null);
    expect(header()).not.toContain('Unlimited');
  });
});

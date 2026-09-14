// @vitest-environment jsdom
// Executes the fee-selection paths of useGasEstimation with realistic calldata (a USDC
// transfer from a USDC-only account) and scripted bundler outcomes, covering the
// auto-switch rules: prefund errors and unrecognized ETH-estimation failures fall back to
// an ERC-20 whose paymaster estimate succeeded (proven by its priced ceiling), while call
// reverts and balance shortfalls are reported instead of re-routed, and a user's own token
// choice survives a re-estimation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Address } from 'viem';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@jaw.id/core', () => ({
  estimateErc20PaymasterCosts: vi.fn(),
  jawPaymasterUrl: (chainId: number, apiKey?: string) =>
    `https://paymaster.test?chainId=${chainId}${apiKey ? `&api-key=${apiKey}` : ''}`,
}));

import { estimateErc20PaymasterCosts } from '@jaw.id/core';
import type { Account } from '@jaw.id/core';
import { useGasEstimation, type UseGasEstimationResult, type TransactionCall } from './useGasEstimation';
import type { FeeTokenOption } from '../components/FeeTokenSelector';

const erc20Mock = vi.mocked(estimateErc20PaymasterCosts);

// Base Sepolia USDC, and a plain ERC-20 transfer of 1 USDC — the calldata a
// USDC-only account would actually submit.
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as Address;
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const TRANSFER_CALLDATA = ('0xa9059cbb' +
  RECIPIENT.slice(2).padStart(64, '0') +
  (1_000_000).toString(16).padStart(64, '0')) as `0x${string}`;
const CALLS: TransactionCall[] = [{ to: USDC, value: 0n, data: TRANSFER_CALLDATA }];

const makeAccount = (calculateGasCost: () => Promise<string>): Account =>
  ({
    calculateGasCost,
    getSmartAccountFor: async () => ({}),
    getChain: () => ({ id: 84532 }),
  }) as unknown as Account;

const token = (over: Partial<FeeTokenOption>): FeeTokenOption => ({
  uid: over.symbol ?? 'tok',
  symbol: 'USDC',
  address: USDC,
  decimals: 6,
  balance: 10_000_000n,
  balanceFormatted: '10',
  isNative: false,
  // The producer's pre-estimation heuristic (balance >= 0.5) — NOT proof it can pay.
  isSelectable: true,
  ...over,
});

const nativeEth = (balance: bigint) =>
  token({
    symbol: 'ETH',
    address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    decimals: 18,
    balance,
    balanceFormatted: balance > 0n ? '1' : '0',
    isNative: true,
    isSelectable: balance > 0n,
  });

const usdcEstimate = {
  tokenAddress: USDC,
  tokenCostFormatted: '0.02',
  tokenCostMaxFormatted: '0.05',
  hasSufficientBalance: true,
};
const usdtEstimate = { ...usdcEstimate, tokenAddress: USDT };

let hook: UseGasEstimationResult;
let tokensNow: FeeTokenOption[];

let setTokensExternally: (tokens: FeeTokenOption[]) => void;
let setCallsExternally: (calls: TransactionCall[]) => void;
let setApiKeyExternally: (apiKey: string) => void;

function Probe({
  account,
  initialTokens,
  initialCalls = CALLS,
}: {
  account: Account;
  initialTokens: FeeTokenOption[];
  initialCalls?: TransactionCall[];
}) {
  const [tokens, setTokens] = useState(initialTokens);
  const [calls, setCalls] = useState(initialCalls);
  const [apiKey, setApiKey] = useState('test-key');
  tokensNow = tokens;
  setTokensExternally = setTokens;
  setCallsExternally = setCalls;
  setApiKeyExternally = setApiKey;
  hook = useGasEstimation({
    account,
    transactionCalls: calls,
    chainId: 84532,
    apiKey,
    feeTokens: tokens,
    onFeeTokensUpdate: setTokens,
  });
  return null;
}

let root: Root | null = null;

async function mount(account: Account, initialTokens: FeeTokenOption[], initialCalls?: TransactionCall[]) {
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(createElement(Probe, { account, initialTokens, initialCalls }));
  });
  await settle();
}

async function flush() {
  for (let i = 0; i < 20; i++) await act(() => Promise.resolve());
}

async function settle() {
  for (let i = 0; i < 20 && hook.gasFeeLoading; i++) {
    await act(() => Promise.resolve());
  }
  expect(hook.gasFeeLoading).toBe(false);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.restoreAllMocks();
});

describe('useGasEstimation fee-token selection', () => {
  it('funded account, clean estimation: auto-selects native', async () => {
    erc20Mock.mockResolvedValue([usdcEstimate]);
    await mount(
      makeAccount(async () => '0.0002'),
      [nativeEth(10n ** 18n), token({})]
    );

    expect(hook.gasFee).toBe('0.0002');
    expect(hook.gasEstimationError).toBe('');
    expect(hook.selectedFeeToken?.isNative).toBe(true);
    expect(hook.isPayingWithErc20).toBe(false);
  });

  it('USDC-only account, AA21 prefund error: auto-switches to USDC', async () => {
    erc20Mock.mockResolvedValue([usdcEstimate]);
    await mount(
      makeAccount(async () => {
        throw new Error("UserOperation reverted during simulation: AA21 didn't pay prefund");
      }),
      [nativeEth(0n), token({})]
    );

    expect(hook.gasEstimationError).toBe('');
    expect(hook.selectedFeeToken?.symbol).toBe('USDC');
    expect(hook.isPayingWithErc20).toBe(true);
    expect(hook.selectedFeeToken?.gasCostMaxFormatted).toBe('0.05');
  });

  it('USDC-only account, unrecognized bundler wording: still auto-switches to the proven USDC', async () => {
    erc20Mock.mockResolvedValue([usdcEstimate]);
    await mount(
      makeAccount(async () => {
        throw new Error('bundler rejected the operation: gas prefund could not be covered by sender');
      }),
      [nativeEth(0n), token({})]
    );

    expect(hook.gasEstimationError).toBe('');
    expect(hook.selectedFeeToken?.symbol).toBe('USDC');
    expect(hook.isPayingWithErc20).toBe(true);
  });

  it('call revert fails both paths: reports failure, never re-routes the fee', async () => {
    const revert = new Error('execution reverted: INSUFFICIENT_OUTPUT_AMOUNT');
    erc20Mock.mockRejectedValue(revert);
    await mount(
      makeAccount(async () => {
        throw revert;
      }),
      [nativeEth(0n), token({})]
    );

    expect(hook.gasEstimationError).toBe('Failed to estimate gas');
    expect(hook.selectedFeeToken).toBeNull();
    // The rejected ERC-20 estimation must strip the heuristic selectability.
    expect(tokensNow.find((t) => !t.isNative)?.isSelectable).toBe(false);
  });

  it('balance-classified revert: reports Insufficient funds even with a proven USDC available', async () => {
    erc20Mock.mockResolvedValue([usdcEstimate]);
    await mount(
      makeAccount(async () => {
        throw new Error('execution reverted: ERC20: transfer amount exceeds balance');
      }),
      [nativeEth(0n), token({})]
    );

    expect(hook.gasEstimationError).toBe('Insufficient funds');
    expect(hook.selectedFeeToken).toBeNull();
  });

  it('unknown error with only heuristic selectability (no ceiling): no auto-switch', async () => {
    // Estimation "succeeds" but returns nothing for the token — its isSelectable stays the
    // pre-estimation balance heuristic, which must not count as proof it can pay.
    erc20Mock.mockResolvedValue([]);
    await mount(
      makeAccount(async () => {
        throw new Error('Internal JSON-RPC error');
      }),
      [nativeEth(0n), token({})]
    );

    expect(hook.gasEstimationError).toBe('Failed to estimate gas');
    expect(hook.selectedFeeToken).toBeNull();
  });

  it('a token picked while estimation is in flight survives its completion', async () => {
    erc20Mock.mockResolvedValue([usdcEstimate]);
    let resolveEth!: (v: string) => void;
    const account = makeAccount(() => new Promise<string>((r) => (resolveEth = r)));
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root!.render(createElement(Probe, { account, initialTokens: [nativeEth(10n ** 18n), token({})] }));
    });

    // ETH estimation still pending — the user picks USDC now.
    const usdc = tokensNow.find((t) => !t.isNative)!;
    act(() => hook.setSelectedFeeToken(usdc));
    expect(hook.selectedFeeToken?.symbol).toBe('USDC');

    await act(async () => resolveEth('0.0002'));
    await settle();

    // Completion must not resurrect the stale "nothing selected" auto-pick of native.
    expect(hook.selectedFeeToken?.symbol).toBe('USDC');
    expect(hook.isPayingWithErc20).toBe(true);
  });

  it("re-estimation failure keeps the user's own ERC-20 choice", async () => {
    erc20Mock.mockResolvedValue([usdcEstimate, usdtEstimate]);
    await mount(
      makeAccount(async () => {
        throw new Error('bundler timeout while estimating');
      }),
      [nativeEth(0n), token({}), token({ symbol: 'USDT', address: USDT })]
    );

    expect(hook.selectedFeeToken?.symbol).toBe('USDC'); // first proven token wins initially

    const usdt = tokensNow.find((t) => t.symbol === 'USDT');
    expect(usdt?.gasCostMaxFormatted).toBe('0.05');
    act(() => hook.setSelectedFeeToken(usdt!));

    await act(async () => {
      hook.refetch();
    });
    await settle();

    expect(hook.gasEstimationError).toBe('');
    expect(hook.selectedFeeToken?.symbol).toBe('USDT');
  });

  // The ETH estimate depends on the calls, never on the fee-token list. These pin that a later
  // token list reuses it, and that every path which invalidates the fee re-measures instead.
  describe('ETH estimate reuse', () => {
    it('does not re-measure when only the fee-token list changed', async () => {
      erc20Mock.mockResolvedValue([usdcEstimate]);
      const calc = vi.fn(async () => '0.0001');
      await mount(makeAccount(calc), [nativeEth(1n)]);

      expect(calc).toHaveBeenCalledTimes(1);
      expect(hook.gasFee).toBe('0.0001');

      // Balances land, introducing an ERC-20 — this is what re-triggers estimation.
      await act(async () => setTokensExternally([nativeEth(1n), token({})]));
      await flush();

      expect(calc).toHaveBeenCalledTimes(1);
      expect(hook.gasFee).toBe('0.0001');
    });

    it('re-measures on refetch', async () => {
      erc20Mock.mockResolvedValue([usdcEstimate]);
      const calc = vi.fn(async () => '0.0001');
      await mount(makeAccount(calc), [nativeEth(1n)]);
      expect(calc).toHaveBeenCalledTimes(1);

      await act(async () => {
        hook.refetch();
      });
      await flush();

      expect(calc).toHaveBeenCalledTimes(2);
    });

    it('re-measures when the apiKey arrives after the first estimate', async () => {
      erc20Mock.mockResolvedValue([usdcEstimate]);
      const calc = vi.fn(async () => '0.0001');
      await mount(makeAccount(calc), [nativeEth(1n)]);
      expect(calc).toHaveBeenCalledTimes(1);

      // A key change points estimation at a different endpoint — the old fee is not reusable.
      await act(async () => setApiKeyExternally('real-key'));
      await flush();

      expect(calc).toHaveBeenCalledTimes(2);
    });
  });

  // The permission dialogs estimate against a ZERO_ADDRESS dummy call until the real grant or
  // revoke call is built. These pin that the swap to the real call re-enters the loading state
  // (the dummy-derived fee must not read as final), while a token list arriving with unchanged
  // inputs still doesn't flash "Estimating..." over a fee that was measured for these exact calls.
  describe('loading state across re-estimation', () => {
    it('shows loading again when the dummy call is replaced by the real call', async () => {
      erc20Mock.mockResolvedValue([]);
      const resolvers: Array<(v: string) => void> = [];
      const calc = vi.fn(() => new Promise<string>((r) => resolvers.push(r)));
      root = createRoot(document.createElement('div'));
      await act(async () => {
        // Empty calls — the hook substitutes its internal dummy call, like the dialogs pre-data.
        root!.render(
          createElement(Probe, { account: makeAccount(calc), initialTokens: [nativeEth(1n)], initialCalls: [] })
        );
      });
      await act(async () => resolvers[0]('0.0001'));
      await settle();
      expect(hook.gasFee).toBe('0.0001');

      // The real call lands. The dummy-derived fee is stale: the row must read as loading.
      await act(async () => setCallsExternally(CALLS));
      expect(hook.gasFeeLoading).toBe(true);

      await act(async () => resolvers[1]('0.0003'));
      await settle();
      expect(hook.gasFee).toBe('0.0003');
    });

    it('does not flash loading when only the fee-token list changed', async () => {
      let resolveErc20: ((v: (typeof usdcEstimate)[]) => void) | undefined;
      // Mount holds no ERC-20 token, so the paymaster estimator is not called at all here —
      // the pending implementation below is consumed by the re-run the new token triggers.
      const calc = vi.fn(async () => '0.0001');
      await mount(makeAccount(calc), [nativeEth(1n)]);
      expect(hook.gasFee).toBe('0.0001');

      // Balances land, introducing an ERC-20. While its estimate is in flight, the measured
      // ETH fee stays on screen — no fallback to "Estimating...".
      erc20Mock.mockImplementationOnce(() => new Promise((r) => (resolveErc20 = r)));
      await act(async () => setTokensExternally([nativeEth(1n), token({})]));
      for (let i = 0; i < 10 && !resolveErc20; i++) await act(() => Promise.resolve());
      expect(resolveErc20).toBeDefined();
      expect(hook.gasFeeLoading).toBe(false);
      expect(hook.gasFee).toBe('0.0001');

      await act(async () => resolveErc20!([usdcEstimate]));
      await flush();
      expect(hook.gasFee).toBe('0.0001');
      expect(calc).toHaveBeenCalledTimes(1);
    });
  });
});

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
import fc from 'fast-check';

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

  it('ETH empty and the USDC estimation reverts: the USDC option carries the reason', async () => {
    erc20Mock.mockRejectedValue(new Error('execution reverted: Across quote expired\nVersion: viem'));
    await mount(
      makeAccount(async () => {
        throw new Error("UserOperation reverted during simulation: AA21 didn't pay prefund");
      }),
      [nativeEth(0n), token({})]
    );

    expect(console.error).toHaveBeenCalledWith(
      '[useGasEstimation] ERC-20 estimation failed:',
      expect.objectContaining({ message: expect.stringContaining('Across quote expired') })
    );
    expect(tokensNow.find((t) => !t.isNative)?.estimationFailure).toBe('execution reverted: Across quote expired');
  });

  it('a prefund error on the USDC leg is a shortfall and carries no estimation failure', async () => {
    erc20Mock.mockRejectedValue(new Error("AA21 didn't pay prefund"));
    await mount(
      makeAccount(async () => {
        throw new Error("AA21 didn't pay prefund");
      }),
      [nativeEth(0n), token({})]
    );

    expect(tokensNow.find((t) => !t.isNative)?.estimationFailure).toBeUndefined();
    expect(hook.gasEstimationError).toBe('Insufficient funds');
  });

  it('a retry that succeeds clears the failure', async () => {
    erc20Mock.mockRejectedValueOnce(new Error('execution reverted'));
    await mount(
      makeAccount(async () => {
        throw new Error("AA21 didn't pay prefund");
      }),
      [nativeEth(0n), token({})]
    );
    expect(tokensNow.find((t) => !t.isNative)?.estimationFailure).toBeDefined();

    erc20Mock.mockResolvedValue([usdcEstimate]);
    await act(async () => hook.refetch());
    await flush();
    expect(tokensNow.find((t) => !t.isNative)?.estimationFailure).toBeUndefined();
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

// What each fee token says after a round, for every way the ERC-20 leg can end. The dialog
// derives its block reason from these fields, so a stale or misplaced one changes the banner.
describe('useGasEstimation fee-token outcome per ERC-20 result', () => {
  const ZERO_TOKEN = '0x2222222222222222222222222222222222222222' as Address;
  const usdcNow = () => tokensNow.find((t) => t.symbol === 'USDC')!;
  const zeroNow = () => tokensNow.find((t) => t.symbol === 'ZERO')!;
  const empty = (over: Partial<FeeTokenOption> = {}) =>
    token({ symbol: 'ZERO', address: ZERO_TOKEN, balance: 0n, balanceFormatted: '0', isSelectable: false, ...over });
  const ethOk = () => makeAccount(async () => '0.0001');

  beforeEach(() => erc20Mock.mockReset());

  it('success: each token gets its own quote and the estimates are exposed', async () => {
    erc20Mock.mockResolvedValue([usdcEstimate, { ...usdtEstimate, tokenCostFormatted: '0.03' }]);
    await mount(ethOk(), [nativeEth(10n ** 18n), token({}), token({ symbol: 'USDT', address: USDT })]);

    expect(usdcNow().gasCostFormatted).toBe('0.02');
    expect(tokensNow.find((t) => t.symbol === 'USDT')?.gasCostFormatted).toBe('0.03');
    expect(hook.tokenEstimates.map((e) => e.tokenAddress)).toEqual([USDC, USDT]);
  });

  it('success: a funded token the paymaster did not quote keeps the round healthy', async () => {
    erc20Mock.mockResolvedValue([]);
    await mount(ethOk(), [nativeEth(10n ** 18n), token({})]);

    expect(hook.gasEstimationError).toBe('');
    expect(hook.gasFee).toBe('0.0001');
  });

  it('success: a token whose balance is gone is never offered, whatever it said before', async () => {
    erc20Mock.mockResolvedValue([usdcEstimate]);
    await mount(ethOk(), [
      nativeEth(10n ** 18n),
      token({}),
      empty({ isSelectable: true, gasCostFormatted: '0.02', estimationFailure: 'old' }),
    ]);

    expect(zeroNow()).toMatchObject({ isSelectable: false, gasCostFormatted: undefined, estimationFailure: undefined });
  });

  it('works without an onFeeTokensUpdate listener', async () => {
    erc20Mock.mockResolvedValue([usdcEstimate]);
    let result!: UseGasEstimationResult;
    const account = ethOk();
    const feeTokens = [nativeEth(10n ** 18n), token({})];
    function Bare() {
      result = useGasEstimation({ account, transactionCalls: CALLS, chainId: 84532, apiKey: 'k', feeTokens });
      return null;
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(createElement(Bare)));
    await flush();
    expect(result.gasEstimationError).toBe('');
    expect(result.gasFee).toBe('0.0001');

    erc20Mock.mockRejectedValue(new Error('execution reverted'));
    await act(async () => result.refetch());
    await flush();
    expect(result.gasEstimationError).toBe('');
  });

  it('prefund error: funded tokens read Insufficient, empty ones carry nothing, native is untouched', async () => {
    erc20Mock.mockRejectedValue(new Error("AA21 didn't pay prefund"));
    await mount(ethOk(), [nativeEth(10n ** 18n), token({}), empty()]);

    expect(usdcNow()).toMatchObject({ gasCostFormatted: 'Insufficient', isSelectable: false });
    expect(zeroNow()).toMatchObject({ gasCostFormatted: undefined, isSelectable: false });
    expect(tokensNow.find((t) => t.isNative)?.isSelectable).toBe(true);
    expect(hook.gasEstimationError).toBe('');
  });

  it('prefund error naming the amount: the token shows the required amount', async () => {
    erc20Mock.mockRejectedValue(new Error("AA21 didn't pay prefund: 0.52 USDC required but sender has 0.10 USDC"));
    await mount(ethOk(), [nativeEth(10n ** 18n), token({})]);

    expect(usdcNow().gasCostFormatted).toBe('0.52');
  });

  it('other error: funded tokens read Estimation failed with the reason, empty ones carry nothing', async () => {
    erc20Mock.mockRejectedValue(new Error('execution reverted: Across quote expired\nVersion: viem@2'));
    await mount(ethOk(), [nativeEth(10n ** 18n), token({}), empty({ isSelectable: true })]);

    expect(usdcNow()).toMatchObject({
      gasCostFormatted: 'Estimation failed',
      isSelectable: false,
      estimationFailure: 'execution reverted: Across quote expired',
    });
    expect(zeroNow()).toMatchObject({ gasCostFormatted: undefined, isSelectable: false, estimationFailure: undefined });
    expect(tokensNow.find((t) => t.isNative)?.isSelectable).toBe(true);
  });

  it('balance revert on the ERC-20 leg is a shortfall, not an estimation failure', async () => {
    erc20Mock.mockRejectedValue(new Error('execution reverted: ERC20: transfer amount exceeds balance'));
    await mount(
      makeAccount(async () => {
        throw new Error("AA21 didn't pay prefund");
      }),
      [nativeEth(0n), token({})]
    );

    expect(usdcNow()).toMatchObject({ isSelectable: false, estimationFailure: undefined });
    expect(hook.gasEstimationError).toBe('Insufficient funds');
  });

  it('a revert that quotes a prefund-style amount is still an estimation failure', async () => {
    erc20Mock.mockRejectedValue(new Error('execution reverted: 0.5 USDC required but sender has 9 USDC'));
    await mount(ethOk(), [nativeEth(0n), token({})]);

    expect(usdcNow()).toMatchObject({
      gasCostFormatted: 'Estimation failed',
      estimationFailure: 'execution reverted: 0.5 USDC required but sender has 9 USDC',
    });
  });

  it.each([
    ['an empty message', new Error(''), 'Unknown error'],
    ['a string', 'paymaster unreachable', 'paymaster unreachable'],
    ['undefined', undefined, 'Unknown error'],
    ['an RPC error object', { code: -32000, message: 'execution reverted: paused' }, 'execution reverted: paused'],
    ['an object without a message', { code: -32000 }, 'Unknown error'],
    ['a blank first line', new Error('\n  \nexecution reverted: paused\nVersion: viem'), 'execution reverted: paused'],
    ['only whitespace', new Error(' \t '), 'Unknown error'],
    ['tabs between words', new Error('execution\treverted'), 'execution reverted'],
    [
      'control and bidi characters',
      new Error('reverted:\u0007 \u202Edesrever\u202C ok\u0000'),
      'reverted: desrever ok',
    ],
  ])('a rejection with %s still records a readable failure', async (_label, reason, expected) => {
    erc20Mock.mockRejectedValue(reason);
    await mount(ethOk(), [nativeEth(0n), token({})]);

    expect(usdcNow().estimationFailure).toBe(expected);
  });

  it('cuts a very long reason to fit the tooltip', async () => {
    erc20Mock.mockRejectedValue(new Error(`execution reverted: 0x${'ab'.repeat(5000)}`));
    await mount(ethOk(), [nativeEth(0n), token({})]);

    const failure = usdcNow().estimationFailure!;
    expect([...failure]).toHaveLength(160);
    expect(failure.startsWith('execution reverted: 0xabab')).toBe(true);
    expect(failure.endsWith('…')).toBe(true);
  });

  it('keeps a reason that exactly fits the tooltip whole', async () => {
    const fits = `execution reverted: ${'x'.repeat(140)}`;
    erc20Mock.mockRejectedValue(new Error(fits));
    await mount(ethOk(), [nativeEth(0n), token({})]);

    expect(usdcNow().estimationFailure).toBe(fits);
  });

  it('records a short, single-line, printable reason for any rejection', async () => {
    // eslint-disable-next-line no-control-regex
    const unprintable = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/;
    const reasons = fc.oneof(
      fc.anything(),
      fc.string({ unit: 'binary', maxLength: 400 }),
      fc.string({ unit: 'binary', maxLength: 400 }).map((m) => new Error(m))
    );
    await fc.assert(
      fc.asyncProperty(reasons, async (reason) => {
        erc20Mock.mockReset();
        erc20Mock.mockRejectedValue(reason);
        await mount(ethOk(), [nativeEth(0n), token({})]);
        const failure = usdcNow().estimationFailure;
        act(() => root!.unmount());
        root = null;
        // A balance revert is a shortfall and records no failure at all.
        if (failure === undefined) return true;
        return failure.trim() !== '' && [...failure].length <= 160 && !unprintable.test(failure);
      }),
      { numRuns: 60 }
    );
  });

  // A later round rewrites every field the earlier round set, so the banner follows the latest round.
  describe('a later round replaces the earlier failure', () => {
    const failFirst = async () => {
      erc20Mock.mockRejectedValueOnce(new Error('execution reverted'));
      // USDT stays funded so the ERC-20 leg still runs once USDC is emptied.
      await mount(ethOk(), [nativeEth(0n), token({}), token({ symbol: 'USDT', address: USDT }), empty()]);
      expect(usdcNow().estimationFailure).toBe('execution reverted');
    };
    const retry = async () => {
      await act(async () => hook.refetch());
      await flush();
    };

    it('by a prefund shortfall', async () => {
      await failFirst();
      erc20Mock.mockRejectedValueOnce(new Error("AA21 didn't pay prefund"));
      await retry();
      expect(usdcNow()).toMatchObject({ gasCostFormatted: 'Insufficient', estimationFailure: undefined });
    });

    it('by a balance revert', async () => {
      await failFirst();
      erc20Mock.mockRejectedValueOnce(new Error('ERC20: transfer amount exceeds balance'));
      await retry();
      expect(usdcNow().estimationFailure).toBeUndefined();
    });

    it('by a quote', async () => {
      await failFirst();
      erc20Mock.mockResolvedValueOnce([usdcEstimate]);
      await retry();
      expect(usdcNow()).toMatchObject({ gasCostFormatted: '0.02', isSelectable: true, estimationFailure: undefined });
    });

    it('by a quote that leaves a token unquoted', async () => {
      await failFirst();
      // The paymaster quotes USDC, which cannot cover the fee, and no longer quotes USDT.
      erc20Mock.mockResolvedValueOnce([{ ...usdcEstimate, hasSufficientBalance: false }]);
      await retry();
      // A leftover USDT failure would turn this shortfall into "Fee estimation failed".
      expect(tokensNow.filter((t) => t.estimationFailure)).toEqual([]);
    });

    it.each([
      ['a quote', () => erc20Mock.mockResolvedValueOnce([])],
      ['a prefund shortfall', () => erc20Mock.mockRejectedValueOnce(new Error("AA21 didn't pay prefund"))],
      ['another failure', () => erc20Mock.mockRejectedValueOnce(new Error('timeout'))],
    ])('by %s after the balance ran out', async (_label, next) => {
      await failFirst();
      await act(async () =>
        setTokensExternally(tokensNow.map((t) => (t.symbol === 'USDC' ? { ...t, balance: 0n } : t)))
      );
      next();
      await retry();
      expect(usdcNow()).toMatchObject({ isSelectable: false, estimationFailure: undefined });
    });
  });

  describe('ordering', () => {
    type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
    const deferred = <T>(): Deferred<T> => {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
      return { promise, resolve, reject };
    };

    it.each(['erc20 first', 'native first'])('legs settling %s give the same result', async (order) => {
      const eth = deferred<string>();
      const erc20 = deferred<(typeof usdcEstimate)[]>();
      erc20Mock.mockImplementationOnce(() => erc20.promise);
      root = createRoot(document.createElement('div'));
      await act(async () => {
        root!.render(
          createElement(Probe, { account: makeAccount(() => eth.promise), initialTokens: [nativeEth(0n), token({})] })
        );
      });
      const failErc20 = () => erc20.reject(new Error('execution reverted'));
      const failEth = () => eth.reject(new Error("AA21 didn't pay prefund"));
      for (const settle of order === 'erc20 first' ? [failErc20, failEth] : [failEth, failErc20]) {
        await act(async () => settle());
        await flush();
      }

      expect(usdcNow().estimationFailure).toBe('execution reverted');
      expect(hook.gasEstimationError).toBe('Insufficient funds');
      expect(hook.gasFeeLoading).toBe(false);
    });

    it.each([
      ['a stale failure after a newer success', 'reject', 'resolve'],
      ['a stale success after a newer failure', 'resolve', 'reject'],
    ])('ignores %s', async (_label, first, second) => {
      const legs = [deferred<(typeof usdcEstimate)[]>(), deferred<(typeof usdcEstimate)[]>()];
      erc20Mock.mockImplementationOnce(() => legs[0].promise).mockImplementationOnce(() => legs[1].promise);
      const settle = (d: Deferred<(typeof usdcEstimate)[]>, how: string) =>
        how === 'resolve' ? d.resolve([usdcEstimate]) : d.reject(new Error('execution reverted'));
      root = createRoot(document.createElement('div'));
      await act(async () => {
        root!.render(createElement(Probe, { account: ethOk(), initialTokens: [nativeEth(0n), token({})] }));
      });
      await flush();
      await act(async () => hook.refetch());
      await flush();

      // The retry settles first, then the round it replaced.
      await act(async () => settle(legs[1], second));
      await flush();
      await act(async () => settle(legs[0], first));
      await flush();

      const failed = second === 'reject';
      expect(usdcNow().estimationFailure).toBe(failed ? 'execution reverted' : undefined);
      expect(usdcNow().isSelectable).toBe(!failed);
    });
  });
});

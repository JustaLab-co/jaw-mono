// @vitest-environment jsdom
// The fee picker offers a token only when what the batch leaves of it covers the fee. What the
// batch moves out comes from the asset preview, so the popup has to hand it to the gas estimate
// once the preview has run, and only when the account the preview read is the one that pays.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Chain } from '@jaw.id/core';
import type { TransactionRequestData } from './index';

/** What the modal handed the gas estimate as the batch's outflow, on the last render. */
let estimatedAssetsOut: unknown = 'never called';

type FeeToken = { address: string; isNative: boolean };
type DialogProps = {
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  onOpenChange: (open: boolean) => void;
  onFeeTokenSelect: (token: FeeToken | null) => void;
  transactions: Array<{ to: string; data: string; value: string; chainId: number }>;
  sponsored: boolean;
  showFeeTokenSelector: boolean;
  feeTokens: unknown[];
  networkName: string;
  mainnetRpcUrl: string;
  isProcessing: boolean;
  estimatingTokenCosts: boolean;
};
/** Props the modal handed the dialog on the last render. */
let dialog: DialogProps;
/** What the gas estimate reports as the selected fee token and its estimates. */
let selectedFeeToken: FeeToken | null = null;
let tokenEstimates: Array<{ tokenAddress: string; tokenCostMax: bigint }> = [];
const setSelectedFeeToken = vi.fn();
let feeTokenCapability: { supported: boolean } | undefined;
let capabilitiesFail = false;
const loadFeeTokenOptions = vi.fn(async () => [{ address: '0x4444444444444444444444444444444444444444' }]);
const sendCalls = vi.fn();
const sendTransaction = vi.fn();
let account: object | null = { sendCalls, sendTransaction };
const OUT = [{ address: '0x3333333333333333333333333333333333333333', diff: -5n, direction: 'out' }];
let previewSimulated = true;
let payingWithErc20 = false;

vi.mock('@jaw.id/ui', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/ui')>();
  return {
    ...actual,
    TransactionDialog: (props: DialogProps) => {
      dialog = props;
      return null;
    },
    loadFeeTokenOptions: (...args: unknown[]) => loadFeeTokenOptions(...(args as [])),
    usePermissionExecution: () => ({ onBehalfOf: undefined, loading: false, problem: undefined }),
    useAssetPreview: () => ({
      assetsOut: OUT,
      assetsIn: [],
      error: false,
      loading: !previewSimulated,
      simulated: previewSimulated,
      willRevert: false,
      revertCause: undefined,
    }),
    useGasEstimation: ({ assetsOut }: { assetsOut?: unknown }) => {
      estimatedAssetsOut = assetsOut;
      return {
        gasFee: '',
        gasFeeLoading: false,
        gasEstimationError: '',
        tokenEstimates,
        estimatingTokenCosts: false,
        selectedFeeToken,
        setSelectedFeeToken,
        isPayingWithErc20: payingWithErc20,
        refetch: () => undefined,
      };
    },
  };
});

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    handleGetCapabilitiesRequest: async () => {
      if (capabilitiesFail) throw new Error('offline');
      return feeTokenCapability ? { '0x2105': { feeToken: feeTokenCapability } } : {};
    },
  };
});

vi.mock('../../hooks', () => ({
  useSessionAccount: () => ({
    account,
    isLoading: false,
    walletAddress: '0x1111111111111111111111111111111111111111',
  }),
}));

const { TransactionModal } = await import('./index');

const CHAIN = { id: 8453, rpcUrl: 'https://rpc.example' } as Chain;
const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const USDC = '0x4444444444444444444444444444444444444444';
const request = (permissionId?: `0x${string}`): TransactionRequestData => ({
  method: 'wallet_sendCalls',
  transactions: [{ to: TO, value: '0x0', chainId: 8453 }],
  chainId: 8453,
  from: FROM,
  permissionId,
});

let root: Root;

const onSuccess = vi.fn();
const onError = vi.fn();

async function open(
  transactionRequest: TransactionRequestData | undefined,
  props: Partial<Parameters<typeof TransactionModal>[0]> = {}
) {
  await act(async () => {
    root.render(
      <TransactionModal
        transactionRequest={transactionRequest}
        chain={CHAIN}
        apiKey="test-key"
        onSuccess={onSuccess}
        onError={onError}
        {...props}
      />
    );
  });
}

const confirm = () => act(async () => dialog.onConfirm());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  estimatedAssetsOut = 'never called';
  previewSimulated = true;
  payingWithErc20 = false;
  selectedFeeToken = null;
  tokenEstimates = [];
  feeTokenCapability = undefined;
  capabilitiesFail = false;
  account = { sendCalls, sendTransaction };
  for (const m of [setSelectedFeeToken, loadFeeTokenOptions, sendCalls, sendTransaction, onSuccess, onError])
    m.mockClear();
  sendCalls.mockResolvedValue({ id: '0xcalls', chainId: 8453 });
  sendTransaction.mockResolvedValue('0xhash');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

describe('TransactionModal hands the batch outflow to the fee estimate', () => {
  it('once the preview has run', async () => {
    await open(request());
    expect(estimatedAssetsOut).toBe(OUT);
  });

  it('not while the preview has not run', async () => {
    previewSimulated = false;
    await open(request());
    expect(estimatedAssetsOut).toBeUndefined();
  });

  it('not under a permission, where the preview reads the granter and another account pays the fee', async () => {
    await open(request(`0x${'1'.repeat(64)}`));
    expect(estimatedAssetsOut).toBeUndefined();
  });
});

// Until the preview has run the estimate counts no outflow, so an ERC-20 the batch drains can
// read as payable. The fee stays pending, which keeps Confirm disabled, until the preview lands.
describe('TransactionModal holds an ERC-20 fee pending until the batch outflow is known', () => {
  it('while an ERC-20 pays and the preview is loading', async () => {
    payingWithErc20 = true;
    previewSimulated = false;
    await open(request());
    expect(dialog.estimatingTokenCosts).toBe(true);
  });

  it('not once the preview has run', async () => {
    payingWithErc20 = true;
    await open(request());
    expect(dialog.estimatingTokenCosts).toBe(false);
  });

  it('not when the fee is paid in the native token', async () => {
    previewSimulated = false;
    await open(request());
    expect(dialog.estimatingTokenCosts).toBe(false);
  });

  it('not under a permission, where the outflow is not counted', async () => {
    payingWithErc20 = true;
    previewSimulated = false;
    await open(request(`0x${'1'.repeat(64)}`));
    expect(dialog.estimatingTokenCosts).toBe(false);
  });
});

describe('TransactionModal sends what the owner confirms', () => {
  it('wallet_sendCalls goes through sendCalls from the account the request names, and reports its id', async () => {
    await open(request());
    await confirm();

    expect(sendCalls).toHaveBeenCalledWith(
      [{ to: TO, value: 0n, data: '0x' }],
      { permissionId: undefined, from: FROM },
      undefined,
      undefined
    );
    expect(onSuccess).toHaveBeenCalledWith({ id: '0xcalls', chainId: 8453 });
  });

  it('wallet_sendCalls with neither a permission nor a from sends with no options', async () => {
    await open({ ...request(), from: undefined });
    await confirm();

    expect(sendCalls.mock.calls[0][1]).toBeUndefined();
  });

  it('eth_sendTransaction goes through sendTransaction and reports its hash', async () => {
    await open({
      ...request(),
      method: 'eth_sendTransaction',
      transactions: [{ to: TO, data: '0xabcd', value: '0x5', chainId: 8453 }],
    });
    await confirm();

    expect(sendTransaction).toHaveBeenCalledWith([{ to: TO, value: 5n, data: '0xabcd' }], undefined, undefined, FROM);
    expect(onSuccess).toHaveBeenCalledWith({ hash: '0xhash' });
  });

  it('a second confirm while the first is in flight sends nothing more', async () => {
    let finish: (v: unknown) => void = () => undefined;
    sendCalls.mockReturnValue(new Promise((r) => (finish = r)));
    await open(request());

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = dialog.onConfirm();
      await dialog.onConfirm();
    });
    await act(async () => {
      finish({ id: '0xcalls', chainId: 8453 });
      await first;
    });

    expect(sendCalls).toHaveBeenCalledTimes(1);
  });

  it('a request paid by its own paymaster is sponsored and sends through that paymaster', async () => {
    await open({ ...request(), paymasterUrl: 'https://pm.example', paymasterContext: { policy: 'p' } });
    await confirm();

    expect(dialog.sponsored).toBe(true);
    expect(dialog.showFeeTokenSelector).toBe(false);
    expect(sendCalls.mock.calls[0].slice(2)).toEqual(['https://pm.example', { policy: 'p' }]);
  });

  it("a chain's own paymaster is used when the request names none", async () => {
    await open(request(), {
      chain: { ...CHAIN, paymaster: { url: 'https://chain-pm.example', context: { c: 1 } } } as Chain,
    });
    await confirm();

    expect(sendCalls.mock.calls[0].slice(2)).toEqual(['https://chain-pm.example', { c: 1 }]);
  });

  it('an ERC-20 fee token with an estimate pays through the JAW paymaster, approving its ceiling', async () => {
    selectedFeeToken = { address: USDC, isNative: false };
    tokenEstimates = [{ tokenAddress: USDC.toUpperCase().replace('0X', '0x'), tokenCostMax: 40_000n }];
    await open(request());
    await confirm();

    const [, , url, context] = sendCalls.mock.calls[0];
    expect(url).toContain('chainId=8453');
    expect(url).toContain('api-key=test-key');
    expect(context).toEqual({ token: tokenEstimates[0].tokenAddress, gas: '40000' });
  });

  it('an ERC-20 fee token with no estimate yet names only the token, so the account sizes the approval', async () => {
    selectedFeeToken = { address: USDC, isNative: false };
    await open(request());
    await confirm();

    expect(sendCalls.mock.calls[0][3]).toEqual({ token: USDC });
  });

  it('the coin as fee token needs no paymaster', async () => {
    selectedFeeToken = { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', isNative: true };
    await open(request());
    await confirm();

    expect(sendCalls.mock.calls[0].slice(2)).toEqual([undefined, undefined]);
  });
});

describe('TransactionModal reports a failed send with the code a dApp expects', () => {
  it.each([
    ['a dismissed passkey prompt', Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }), 4001],
    ['a prefund the account cannot pay', new Error("AA21 didn't pay prefund"), -32003],
    ['a balance the batch exceeds', new Error('ERC20: transfer amount exceeds balance'), -32003],
    ['anything else', new Error('bundler unreachable'), -32603],
  ])('%s', async (_, error, code) => {
    sendCalls.mockRejectedValue(error);
    await open(request());
    await confirm();

    expect(onError).toHaveBeenCalledWith(error, code);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('a thrown non-error is wrapped and reported as internal', async () => {
    sendCalls.mockRejectedValue('boom');
    await open(request());
    await confirm();

    expect(onError).toHaveBeenCalledWith(new Error('boom'), -32603);
  });

  it('no account yet: nothing is sent and the owner can confirm again', async () => {
    account = null;
    await open(request());
    await confirm();

    expect(onError).toHaveBeenCalledWith(new Error('Account not initialized. Please try again.'), -32603);
    expect(dialog.isProcessing).toBe(false);
  });

  it('no chain: nothing is sent', async () => {
    await open(request(), { chain: undefined });
    await confirm();

    expect(sendCalls).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(new Error('Chain information is required.'), -32603);
  });
});

describe('TransactionModal cancel', () => {
  it('reports a user rejection and clears the fee token', async () => {
    await open(request());
    act(() => dialog.onOpenChange(false));

    expect(onError).toHaveBeenCalledWith(new Error('User rejected the request'), 4001);
    expect(setSelectedFeeToken).toHaveBeenCalledWith(null);
  });

  it('reopening the dialog reports nothing', async () => {
    await open(request());
    act(() => dialog.onOpenChange(true));

    expect(onError).not.toHaveBeenCalled();
  });

  it('is ignored while a confirmed send is in flight', async () => {
    sendCalls.mockReturnValue(new Promise(() => undefined));
    await open(request());
    await act(async () => {
      void dialog.onConfirm();
    });
    act(() => dialog.onCancel());

    expect(onError).not.toHaveBeenCalled();
  });
});

describe('TransactionModal fee tokens', () => {
  it('offers the tokens the chain lists for the fee, read for the paying account', async () => {
    feeTokenCapability = { supported: true };
    await open(request());

    expect(loadFeeTokenOptions).toHaveBeenCalledWith(
      expect.objectContaining({ account: FROM, chainId: 8453, rpcUrl: 'https://rpc.example', apiKey: 'test-key' })
    );
    expect(dialog.showFeeTokenSelector).toBe(true);
  });

  it('a chain with no RPC url reads balances from the public endpoint', async () => {
    feeTokenCapability = { supported: true };
    await open(request(), { chain: { id: 8453 } as Chain });

    expect(loadFeeTokenOptions).toHaveBeenCalledWith(expect.objectContaining({ rpcUrl: 'https://eth.llamarpc.com' }));
  });

  it('a chain that takes no fee token offers none', async () => {
    feeTokenCapability = { supported: false };
    await open(request());

    expect(loadFeeTokenOptions).not.toHaveBeenCalled();
    expect(dialog.showFeeTokenSelector).toBe(false);
  });

  it('capabilities that cannot be read offer none, and the dialog still opens', async () => {
    capabilitiesFail = true;
    await open(request());

    expect(dialog.showFeeTokenSelector).toBe(false);
  });

  it('a sponsored request reads no fee tokens', async () => {
    feeTokenCapability = { supported: true };
    await open({ ...request(), paymasterUrl: 'https://pm.example' });

    expect(loadFeeTokenOptions).not.toHaveBeenCalled();
  });
});

describe('TransactionModal shows what it was asked', () => {
  it('the legacy transactions prop, when no request is given', async () => {
    const legacy = [{ to: TO, data: '0x', value: '1', chainId: 8453 }];
    await open(undefined, { transactions: legacy, sponsored: true });

    expect(dialog.transactions).toEqual(legacy);
    expect(dialog.sponsored).toBe(true);
  });

  it('nothing to show and no chain: an empty batch on Ethereum, with a keyless ENS endpoint', async () => {
    await open(undefined, { chain: undefined, apiKey: undefined });

    expect(dialog.transactions).toEqual([]);
    expect(dialog.networkName).toBe('Ethereum');
    expect(dialog.mainnetRpcUrl).not.toContain('api-key');
  });

  it("the network named from the request's chain when the modal has none", async () => {
    await open(request(), { chain: undefined });

    expect(dialog.networkName).toBe('Base');
  });

  it('a call with no target or data shows an empty target and empty calldata', async () => {
    await open({ ...request(), transactions: [{ value: '0x0', chainId: 8453 }] });

    expect(dialog.transactions[0]).toMatchObject({ to: '', data: '0x' });
  });
});

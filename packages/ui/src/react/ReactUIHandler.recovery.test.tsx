// @vitest-environment jsdom
// `wallet_setupRecovery` changes who can take over the account. The screen only shows and
// approves, as for permissions (R16): the wrapper reads where the change can go, hands
// `setupRecovery` exactly the config the app sent once, and answers the dApp the moment it is
// relayed. When no network can take a change yet, it prices and sends the one activation
// transaction, then reads the networks again, with the request still open (R18).
//
// The dialog is stubbed rather than driven through its buttons, as in the prefund test: what is
// under test is what the wrapper estimates, signs, sends and settles.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import type {
  RecoveryChainConfig,
  RecoveryConfig,
  RecoveryNetworksPlan,
  RecoverySetupResult,
  TransactionCall,
} from '@jaw.id/core';

const setupRecovery = vi.fn();
const getRecoveryNetworks = vi.fn();
const sendTransaction = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({ setupRecovery, getRecoveryNetworks, sendTransaction }) },
    handleGetCapabilitiesRequest: async () => ({}),
  };
});

/** What the wrapper asked to be estimated, and whether as sponsored, on the last render. */
let estimated: { calls: TransactionCall[]; skipped: boolean } = { calls: [], skipped: true };
vi.mock('../hooks/useGasEstimation', () => ({
  useGasEstimation: ({
    transactionCalls,
    isSponsored,
  }: {
    transactionCalls: TransactionCall[];
    isSponsored: boolean;
  }) => {
    estimated = { calls: transactionCalls, skipped: isSponsored };
    return {
      gasFee: '',
      gasFeeLoading: false,
      gasEstimationError: '',
      tokenEstimates: [],
      estimatingTokenCosts: false,
      selectedFeeToken: null,
      setSelectedFeeToken: () => undefined,
      isPayingWithErc20: false,
      refetch: () => undefined,
    };
  },
}));

type DialogProps = {
  config?: RecoveryConfig;
  plan?: RecoveryNetworksPlan | null;
  status?: string;
  onConfirm?: () => void;
  onActivate?: () => void;
  onCancel?: () => void;
  onDone?: (result: RecoverySetupResult) => void;
  onOpenChange?: (open: boolean) => void;
  result?: RecoverySetupResult | null;
};
/** Props the wrapper hands the dialog on the last render; `rendered` is false until it renders. */
let dialogProps: DialogProps = {};
let rendered = false;
vi.mock('../components/RecoveryDialog', () => ({
  RecoveryDialog: (props: DialogProps) => {
    dialogProps = props;
    rendered = true;
    return null;
  },
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const ALICE = `0x${'00'.repeat(12)}${'aa'.repeat(20)}` as const;
const EMPTY: RecoveryChainConfig = { chainId: 84_532, deployed: true, enrolled: true, threshold: 0, recoveries: [] };
const ENROLLED: RecoveryChainConfig = {
  chainId: 84_532,
  deployed: true,
  enrolled: true,
  threshold: 1,
  recoveries: [
    {
      recoveryId: `0x${'01'.repeat(32)}`,
      provider: '0xf67C870EF05A5038a4225456Cb08e238fF3B59b8',
      commitment: ALICE,
      delay: 172_800,
    },
  ],
};
/** A first setup: the connected network can take the change and holds no guardian yet. */
const FIRST_SETUP: RecoveryNetworksPlan = {
  base: EMPTY,
  networks: [{ chainId: 84_532, status: 'ready', config: EMPTY }],
};
/** An edit: the connected network holds a guardian. */
const EDIT: RecoveryNetworksPlan = {
  base: ENROLLED,
  networks: [{ chainId: 84_532, status: 'ready', config: ENROLLED }],
};
/** No network can take a change: the account is deployed nowhere, and one transaction fixes that. */
const NOT_YET: RecoveryNetworksPlan = {
  networks: [
    {
      chainId: 84_532,
      status: 'not-deployed',
      enabledByTransaction: true,
      config: { ...EMPTY, deployed: false, enrolled: false },
    },
  ],
};
const CONFIG: RecoveryConfig = { recoveries: [{ commitment: ALICE, delay: 172_800 }], threshold: 1 };
const LANDED: RecoverySetupResult = {
  door: 'relay',
  batchId: `0x${'cd'.repeat(32)}`,
  chains: [{ chainId: 84_532, status: 'PENDING', txHash: null }],
};

/** Open the recovery dialog, settle the networks read, and return the dApp's pending answer. */
async function openSetup(data: Record<string, unknown> = {}) {
  const handler = new ReactUIHandler();
  (handler as unknown as { config: Record<string, unknown> }).config = {
    apiKey: 'test-key',
    defaultChainId: 84_532,
    paymasters: {},
  };
  const request = {
    id: 'req-recovery',
    type: 'wallet_setupRecovery' as const,
    data: { address: ACCOUNT, chainId: 84_532, ...CONFIG, ...data },
  };
  let answer!: Promise<unknown>;
  await act(async () => {
    answer = handler.request(request as Parameters<ReactUIHandler['request']>[0]);
  });
  let settled = false;
  void answer.then(() => (settled = true));
  // Wrapped: an async function returning the pending answer would wait for it to settle.
  return { answer, isSettled: () => settled };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  setupRecovery.mockReset();
  setupRecovery.mockResolvedValue(LANDED);
  getRecoveryNetworks.mockReset();
  getRecoveryNetworks.mockResolvedValue(FIRST_SETUP);
  sendTransaction.mockReset();
  sendTransaction.mockResolvedValue(`0x${'ef'.repeat(32)}`);
  dialogProps = {};
  rendered = false;
  estimated = { calls: [], skipped: true };
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReactUIHandler signs and settles the recovery the user reviewed', () => {
  it('opens on the networks the account’s key can change', async () => {
    await openSetup();

    expect(getRecoveryNetworks).toHaveBeenCalled();
    expect(dialogProps.plan).toEqual(FIRST_SETUP);
  });

  it('shows the config the app sent, as it is', async () => {
    await openSetup();

    expect(dialogProps.config).toEqual(CONFIG);
  });

  // A first setup and an edit are one signature the relayer lands: the user pays nothing.
  it.each([
    ['a first setup', FIRST_SETUP],
    ['an edit', EDIT],
  ])('prices nothing for %s', async (_, plan) => {
    getRecoveryNetworks.mockResolvedValue(plan);
    await openSetup();

    expect(estimated.calls).toEqual([]);
    expect(estimated.skipped).toBe(true);
  });

  it('signs exactly the config the app sent, once, however fast the button is pressed', async () => {
    await openSetup();
    await act(async () => {
      dialogProps.onConfirm?.();
      dialogProps.onConfirm?.();
    });

    expect(setupRecovery).toHaveBeenCalledTimes(1);
    expect(setupRecovery.mock.calls[0]).toEqual([CONFIG]);
  });

  // Answered the moment the change is relayed, so nothing after it (closing the window, a crash
  // on the outcome screen) can report a rejection for a change that happened. The outcome screen
  // stays up as information; a relayed batch is the dApp's to poll with `getAdminBatch`.
  it('answers the dApp as soon as the change is relayed and keeps the outcome screen up', async () => {
    const { answer } = await openSetup();
    await act(async () => dialogProps.onConfirm?.());

    await expect(answer).resolves.toMatchObject({ approved: true, data: LANDED });
    expect(dialogProps.result).toEqual(LANDED);
    expect(document.querySelector('[data-jaw-modal-container]')).not.toBeNull();
  });

  it('closes the outcome screen on Done without answering again', async () => {
    const { answer } = await openSetup();
    await act(async () => dialogProps.onConfirm?.());
    await act(async () => dialogProps.onDone?.({ ...LANDED, chains: [] }));

    await expect(answer).resolves.toMatchObject({ approved: true, data: LANDED });
    expect(document.querySelector('[data-jaw-modal-container]')).toBeNull();
  });

  it('settles closing the outcome screen as done, not rejected', async () => {
    const { answer } = await openSetup();
    await act(async () => dialogProps.onConfirm?.());
    await act(async () => dialogProps.onOpenChange?.(false));

    await expect(answer).resolves.toMatchObject({ approved: true, data: LANDED });
  });

  // The confirm screen showed a plan from the networks read when the dialog opened; Account plans
  // again from a fresh read when it signs. Nothing is signed that the screen did not show.
  it('refuses to sign when the config changed since the screen showed it', async () => {
    const { answer } = await openSetup();
    getRecoveryNetworks.mockResolvedValue(EDIT);
    await act(async () => dialogProps.onConfirm?.());

    expect(setupRecovery).not.toHaveBeenCalled();
    await expect(answer).resolves.toMatchObject({
      approved: false,
      error: { code: -32603, message: expect.stringMatching(/changed since/) },
    });
  });

  // A managed config already in place: the dialog answers without signing, as Account does for
  // an edit that changes nothing.
  it('answers a no-op without signing anything', async () => {
    const { answer } = await openSetup();
    await act(async () => dialogProps.onDone?.({ door: 'relay', chains: [] }));

    expect(setupRecovery).not.toHaveBeenCalled();
    await expect(answer).resolves.toMatchObject({ approved: true, data: { door: 'relay', chains: [] } });
  });

  it('rejects with 4001 when the passkey prompt is cancelled', async () => {
    setupRecovery.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    const { answer } = await openSetup();
    await act(async () => dialogProps.onConfirm?.());

    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
  });

  it('rejects with 4001 on Cancel before anything is signed', async () => {
    const { answer } = await openSetup();
    await act(async () => dialogProps.onCancel?.());

    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
    expect(setupRecovery).not.toHaveBeenCalled();
  });
});

describe('ReactUIHandler activates the connected network when no network can take a change', () => {
  // The fee shown is the fee of the transaction that goes out: one call to the account itself.
  it('prices the activation transaction', async () => {
    getRecoveryNetworks.mockResolvedValue(NOT_YET);
    await openSetup();

    expect(estimated.skipped).toBe(false);
    expect(estimated.calls).toEqual([{ to: ACCOUNT, value: 0n, data: '0x' }]);
  });

  it('sends the transaction it priced, reads the networks again, and keeps the request open', async () => {
    getRecoveryNetworks.mockResolvedValueOnce(NOT_YET).mockResolvedValue(FIRST_SETUP);
    const { isSettled } = await openSetup();
    const priced = estimated.calls;
    await act(async () => dialogProps.onActivate?.());

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(sendTransaction.mock.calls[0][0]).toBe(priced);
    expect(dialogProps.plan).toEqual(FIRST_SETUP);
    expect(setupRecovery).not.toHaveBeenCalled();
    expect(isSettled()).toBe(false);
  });

  it('keeps the request open when the transaction fails, with the error on screen', async () => {
    getRecoveryNetworks.mockResolvedValue(NOT_YET);
    sendTransaction.mockRejectedValue(new Error('insufficient funds'));
    const { isSettled } = await openSetup();
    await act(async () => dialogProps.onActivate?.());

    expect(dialogProps.status).toMatch(/insufficient funds/);
    expect(dialogProps.plan).toEqual(NOT_YET);
    expect(isSettled()).toBe(false);
  });

  it('sends one transaction however fast the button is pressed', async () => {
    getRecoveryNetworks.mockResolvedValueOnce(NOT_YET).mockResolvedValue(FIRST_SETUP);
    await openSetup();
    await act(async () => {
      dialogProps.onActivate?.();
      dialogProps.onActivate?.();
    });

    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });
});

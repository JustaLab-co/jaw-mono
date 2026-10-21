// @vitest-environment jsdom
// `wallet_setupRecovery` changes who can take over the account. The screen only shows and
// approves, as for permissions (R16): the wrapper reads the configs to pick the flow, prices the
// account-door userOp of a first setup over the config the app sent, hands `setupRecovery` exactly
// that config once, and answers the dApp the moment the change lands.
//
// The dialog is stubbed rather than driven through its buttons, as in the prefund test: what is
// under test is what the wrapper estimates, signs and settles.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import type { RecoveryChainConfig, RecoveryConfig, RecoverySetupResult } from '@jaw.id/core';

const setupRecovery = vi.fn();
const getRecoveryConfig = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: { get: async () => ({ setupRecovery }) },
    getRecoveryConfig: (...args: unknown[]) => getRecoveryConfig(...args),
    handleGetCapabilitiesRequest: async () => ({}),
  };
});

/** What the wrapper asked to be estimated, and whether as sponsored, on the last render. */
let estimated: { calls: Array<{ to: string }>; skipped: boolean } = { calls: [], skipped: true };
vi.mock('../hooks/useGasEstimation', () => ({
  useGasEstimation: ({
    transactionCalls,
    isSponsored,
  }: {
    transactionCalls: Array<{ to: string }>;
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
  current?: RecoveryChainConfig | null;
  onConfirm?: () => void;
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
const NOT_ENROLLED: RecoveryChainConfig = {
  chainId: 84_532,
  deployed: true,
  enrolled: false,
  threshold: 0,
  recoveries: [],
};
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
const CONFIG: RecoveryConfig = { recoveries: [{ commitment: ALICE, delay: 172_800 }], threshold: 1 };
const LANDED: RecoverySetupResult = {
  door: 'account',
  chains: [{ chainId: 84_532, status: 'COMPLETED', txHash: `0x${'ab'.repeat(32)}` }],
};

/** Open the recovery dialog, settle the configs read, and return the dApp's pending answer. */
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
  // Wrapped: an async function returning the pending answer would wait for it to settle.
  return { answer };
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
  getRecoveryConfig.mockReset();
  getRecoveryConfig.mockResolvedValue({ chains: [NOT_ENROLLED] });
  dialogProps = {};
  rendered = false;
  estimated = { calls: [], skipped: true };
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReactUIHandler prices, signs and settles the recovery the user reviewed', () => {
  it('opens on the connected network’s config', async () => {
    await openSetup();

    expect(getRecoveryConfig).toHaveBeenCalledWith(ACCOUNT, 'test-key');
    expect(dialogProps.current).toEqual(NOT_ENROLLED);
  });

  it('shows the config the app sent, as it is', async () => {
    await openSetup();

    expect(dialogProps.config).toEqual(CONFIG);
  });

  // The fee shown is the fee of the userOp that goes out: enrol the manager, add, set threshold.
  it('prices a first setup over the config the app sent, enrolment first', async () => {
    await openSetup();

    expect(estimated.skipped).toBe(false);
    expect(estimated.calls).toHaveLength(3);
    expect(estimated.calls[0].to.toLowerCase()).toBe(ACCOUNT);
  });

  // An edit is one signature the relayer lands; the user pays nothing, so nothing is priced.
  it('prices nothing for an edit', async () => {
    getRecoveryConfig.mockResolvedValue({ chains: [ENROLLED] });
    await openSetup({ recoveries: [{ commitment: ALICE, delay: 259_200 }] });

    expect(estimated.calls).toEqual([]);
  });

  it('signs exactly the config the app sent, once, however fast the button is pressed', async () => {
    await openSetup();
    await act(async () => {
      dialogProps.onConfirm?.();
      dialogProps.onConfirm?.();
    });

    expect(setupRecovery).toHaveBeenCalledTimes(1);
    expect(setupRecovery.mock.calls[0][0]).toEqual(CONFIG);
  });

  // Answered the moment the change lands, so nothing after it (closing the window, a crash on the
  // outcome screen) can report a rejection for a change that happened. The outcome screen stays
  // up as information; a relayed batch is the dApp's to poll with `getAdminBatch`.
  it('answers the dApp as soon as the change lands and keeps the outcome screen up', async () => {
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

  // The confirm screen showed a plan from the configs read when the dialog opened; Account plans
  // again from a fresh read when it signs. Nothing is signed that the screen did not show.
  it('refuses to sign when the config changed since the screen showed it', async () => {
    const { answer } = await openSetup();
    getRecoveryConfig.mockResolvedValue({ chains: [ENROLLED] });
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

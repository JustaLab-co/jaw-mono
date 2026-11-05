// @vitest-environment jsdom
// The guardian and the owner in App-Specific mode. `wallet_approveRecovery` approves one request
// with the signed-in guardian's passkey; `wallet_cancelRecovery` vetoes one with the owner's. On
// the connect screen, a request someone opened for the account on offer shows a warning whose
// "Review and cancel" opens the veto for the newest one.
//
// The approve and cancel dialogs are stubbed rather than driven through their buttons, as in the
// setup test: what is under test is what the wrappers read, sign and settle. The warning is the
// real component, rendered where the stubbed connect screen puts it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import {
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  standardErrors,
  type Ceremony,
  type CeremonyApproval,
  type CeremonyChain,
  type CeremonyListEntry,
  type RecoverySetupResult,
} from '@jaw.id/core';
import type { Address, Hex } from 'viem';

const approveRecovery = vi.fn();
const cancelRecovery = vi.fn();
const getAccount = vi.fn();
const restoreAccount = vi.fn();
const getCeremony = vi.fn();
const listCeremonies = vi.fn();
const currentAccount = vi.fn();
const authenticatedAddress = vi.fn();
const storedAccounts = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: {
      get: (...args: unknown[]) => getAccount(...args),
      restore: (...args: unknown[]) => restoreAccount(...args),
      getStoredAccounts: () => storedAccounts(),
      getCurrentAccount: () => currentAccount(),
      getAuthenticatedAddress: () => authenticatedAddress(),
      backfillStoredAccountAddresses: async () => [],
    },
    getCeremony: (...args: unknown[]) => getCeremony(...args),
    listCeremonies: (...args: unknown[]) => listCeremonies(...args),
  };
});
vi.mock('../hooks/useChainIconURI', () => ({ useChainIconURI: () => null }));
vi.mock('../hooks/useReverseIdentity', () => ({
  useReverseIdentity: () => ({ name: null, plainName: null, avatar: null }),
}));

type ApproveProps = {
  ceremony?: Ceremony | null;
  openRequests?: CeremonyListEntry[] | null;
  guardian?: Address;
  block?: string | null;
  approval?: CeremonyApproval | null;
  onApprove?: () => Promise<void>;
  onCancel?: () => void;
  onDone?: () => void;
};
let approveDialog: ApproveProps | null = null;
vi.mock('../components/GuardianApproveDialog', () => ({
  GuardianApproveDialog: (props: ApproveProps) => {
    approveDialog = props;
    return null;
  },
}));

type CancelProps = {
  ceremony?: Ceremony | null;
  result?: RecoverySetupResult | null;
  error?: string;
  onConfirm?: () => Promise<void>;
  onCancel?: () => void;
  onDone?: (result: RecoverySetupResult) => void;
};
let cancelDialog: CancelProps | null = null;
vi.mock('../components/RecoveryCancelDialog', () => ({
  RecoveryCancelDialog: (props: CancelProps) => {
    cancelDialog = props;
    return null;
  },
}));

type StartProps = { approveUrl?: string; chainId?: number };
let startDialog: StartProps | null = null;
vi.mock('../components/RecoveryStartDialog', () => ({
  RecoveryStartDialog: (props: StartProps) => {
    startDialog = props;
    return null;
  },
}));

type OnboardingProps = { onLostPasskey?: () => void; notice?: ReactNode };
let onboarding: OnboardingProps | null = null;
vi.mock('../components/OnboardingDialog', () => ({
  OnboardingDialog: (props: OnboardingProps) => {
    onboarding = props;
    return <div data-testid="onboarding">{props.notice}</div>;
  },
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

const ACCOUNT: Address = '0x2FA8A6b6C0E3c1d6C2D3cB4C1f0d0B6b0e61C41d';
const GUARDIAN: Address = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';
const GUARDIAN_KEY = `0x${'51'.repeat(64)}` as Hex;
const OTHER_KEY = `0x${'8f'.repeat(64)}` as Hex;
const REQUEST_ID = `0x${'7f'.repeat(32)}` as Hex;
const OLDER_ID = `0x${'11'.repeat(32)}` as Hex;

const chain = (chainId: number, status: CeremonyChain['status']): CeremonyChain => ({
  chainId,
  status,
  executeAt: null,
  requestTxHash: null,
  executeTxHash: null,
});

function ceremony(requestId: Hex = REQUEST_ID, chains: CeremonyChain[] = [chain(84_532, 'COLLECTING')]): Ceremony {
  return {
    requestId,
    account: ACCOUNT,
    subject: `0x${'ab'.repeat(64)}`,
    salt: `0x${'01'.repeat(32)}`,
    expiry: '2026-12-04T12:00:00.000Z',
    createdAt: '2026-11-04T12:00:00.000Z',
    threshold: 2,
    collected: 0,
    guardians: [GUARDIAN_KEY, `0x${'00'.repeat(12)}${'aa'.repeat(20)}` as Hex].map((commitment, n) => ({
      recoveryId: `0x${String(n + 1).repeat(64)}` as Hex,
      provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
      commitment,
      delay: 172_800,
      approvedAt: null,
    })),
    chains,
  };
}

const entry = (requestId: Hex, createdAt: string): CeremonyListEntry => ({
  requestId,
  account: ACCOUNT,
  subject: `0x${'ab'.repeat(64)}`,
  expiry: '2026-12-04T12:00:00.000Z',
  createdAt,
  chains: [chain(84_532, 'COLLECTING')],
});

function handler(config: Record<string, unknown> = {}) {
  const instance = new ReactUIHandler();
  instance.init({ apiKey: 'test-key', defaultChainId: 84_532, paymasters: {}, ...config });
  return instance;
}

/** Send a request to the handler and return the dApp's pending answer. */
async function send(type: string, data: Record<string, unknown>, config?: Record<string, unknown>) {
  let answer!: Promise<unknown>;
  await act(async () => {
    answer = handler(config).request({ id: `req-${type}`, type, data } as Parameters<ReactUIHandler['request']>[0]);
  });
  let settled = false;
  void answer.then(() => (settled = true));
  // Wrapped: an async function returning the pending answer would wait for it to settle.
  return { answer, isSettled: () => settled };
}

const openApprove = () => send('wallet_approveRecovery', { address: GUARDIAN, chainId: 84_532, requestId: REQUEST_ID });
const openCancel = () => send('wallet_cancelRecovery', { address: ACCOUNT, chainId: 84_532, requestId: REQUEST_ID });

/** The guardian signed in on this device with the passkey whose key is `key`. */
function signedInAs(key: Hex) {
  authenticatedAddress.mockReturnValue(GUARDIAN);
  currentAccount.mockReturnValue({ credentialId: 'guardian', publicKey: key, username: 'ghadi', address: GUARDIAN });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  for (const mock of [approveRecovery, cancelRecovery, getAccount, restoreAccount, getCeremony, listCeremonies]) {
    mock.mockReset();
  }
  getAccount.mockResolvedValue({ approveRecovery, cancelRecovery });
  restoreAccount.mockResolvedValue({ cancelRecovery });
  getCeremony.mockImplementation(async (requestId: Hex) => ceremony(requestId));
  listCeremonies.mockResolvedValue([]);
  currentAccount.mockReturnValue(null);
  authenticatedAddress.mockReturnValue(null);
  storedAccounts.mockReturnValue([]);
  approveDialog = null;
  cancelDialog = null;
  startDialog = null;
  onboarding = null;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReactUIHandler approves a recovery for wallet_approveRecovery', () => {
  const APPROVAL: CeremonyApproval = { collected: 1, threshold: 2, queued: false };

  it('reads the request and the account’s open requests, and shows who approves', async () => {
    signedInAs(GUARDIAN_KEY);
    await openApprove();

    expect(getCeremony).toHaveBeenCalledWith(REQUEST_ID, 'test-key');
    expect(approveDialog?.ceremony?.requestId).toBe(REQUEST_ID);
    expect(listCeremonies).toHaveBeenCalledWith(ACCOUNT, { pending: true }, 'test-key');
    expect(approveDialog?.guardian).toBe(GUARDIAN);
    expect(approveDialog?.block).toBeNull();
  });

  it('approves that request id with the guardian’s account and answers with the approval', async () => {
    signedInAs(GUARDIAN_KEY);
    approveRecovery.mockResolvedValue(APPROVAL);
    const { answer } = await openApprove();
    await act(async () => approveDialog?.onApprove?.());

    expect(getAccount).toHaveBeenCalledWith(expect.objectContaining({ chainId: 84_532, apiKey: 'test-key' }));
    expect(approveRecovery).toHaveBeenCalledWith(REQUEST_ID);
    await expect(answer).resolves.toEqual({ id: 'req-wallet_approveRecovery', approved: true, data: APPROVAL });
    // The count stays on screen until Done.
    expect(approveDialog?.approval).toEqual(APPROVAL);
    expect(document.querySelector('[data-jaw-modal-container]')).not.toBeNull();

    await act(async () => approveDialog?.onDone?.());
    expect(document.querySelector('[data-jaw-modal-container]')).toBeNull();
  });

  it('approves once however fast the button is pressed', async () => {
    signedInAs(GUARDIAN_KEY);
    approveRecovery.mockResolvedValue(APPROVAL);
    await openApprove();
    await act(async () => {
      void approveDialog?.onApprove?.();
      void approveDialog?.onApprove?.();
    });

    expect(approveRecovery).toHaveBeenCalledTimes(1);
  });

  it('refuses a key known here that is none of the guardians, before any prompt, and answers -32602', async () => {
    signedInAs(OTHER_KEY);
    const { answer } = await openApprove();

    expect(approveDialog?.block).toBe('not-guardian');
    await act(async () => approveDialog?.onApprove?.());
    expect(getAccount).not.toHaveBeenCalled();
    expect(approveRecovery).not.toHaveBeenCalled();

    await act(async () => approveDialog?.onCancel?.());
    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: -32602 } });
  });

  it('shows core’s refusal of a key it could not judge here as not a guardian, and answers with it', async () => {
    approveRecovery.mockRejectedValue(
      standardErrors.rpc.invalidParams({ message: `This signer is not a guardian of recovery request ${REQUEST_ID}` })
    );
    const { answer, isSettled } = await openApprove();
    expect(approveDialog?.block).toBeNull();

    await act(async () => approveDialog?.onApprove?.());
    expect(approveDialog?.block).toBe('not-guardian');
    expect(isSettled()).toBe(false);

    await act(async () => approveDialog?.onCancel?.());
    await expect(answer).resolves.toMatchObject({
      approved: false,
      error: { code: -32602, message: expect.stringContaining('not a guardian') },
    });
  });

  it('blocks a request that no longer collects approvals', async () => {
    signedInAs(GUARDIAN_KEY);
    getCeremony.mockResolvedValue(ceremony(REQUEST_ID, [chain(84_532, 'REQUESTED')]));
    const { answer } = await openApprove();

    expect(approveDialog?.block).toBe('closed');
    await act(async () => approveDialog?.onCancel?.());
    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: -32602 } });
  });

  it('rejects with 4001 when the passkey prompt is cancelled, and when declined', async () => {
    signedInAs(GUARDIAN_KEY);
    approveRecovery.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    const first = await openApprove();
    await act(async () => approveDialog?.onApprove?.());
    await expect(first.answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });

    const second = await openApprove();
    await act(async () => approveDialog?.onCancel?.());
    await expect(second.answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
  });
});

describe('ReactUIHandler cancels a recovery for wallet_cancelRecovery', () => {
  const RESULT: RecoverySetupResult = {
    door: 'relay',
    batchId: `0x${'cd'.repeat(32)}`,
    chains: [{ chainId: 84_532, status: 'PENDING', txHash: null }],
  };

  it('vetoes the request the app named and answers with the outcome per network as soon as it is relayed', async () => {
    getCeremony.mockResolvedValue(ceremony(REQUEST_ID, [chain(84_532, 'REQUESTED')]));
    cancelRecovery.mockResolvedValue(RESULT);
    const { answer } = await openCancel();

    expect(cancelDialog?.ceremony?.requestId).toBe(REQUEST_ID);
    await act(async () => cancelDialog?.onConfirm?.());

    expect(getAccount).toHaveBeenCalledWith(expect.objectContaining({ chainId: 84_532, apiKey: 'test-key' }));
    expect(cancelRecovery).toHaveBeenCalledWith(REQUEST_ID);
    await expect(answer).resolves.toEqual({ id: 'req-wallet_cancelRecovery', approved: true, data: RESULT });
    expect(cancelDialog?.result).toEqual(RESULT);

    await act(async () => cancelDialog?.onDone?.(RESULT));
    expect(document.querySelector('[data-jaw-modal-container]')).toBeNull();
  });

  it('rejects with 4001 on Not now, with nothing signed', async () => {
    const { answer } = await openCancel();
    await act(async () => cancelDialog?.onCancel?.());

    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
    expect(cancelRecovery).not.toHaveBeenCalled();
  });

  it('keeps core’s -32602 when the request can’t be cancelled', async () => {
    cancelRecovery.mockRejectedValue(standardErrors.rpc.invalidParams({ message: 'not pending on any chain' }));
    const { answer } = await openCancel();
    await act(async () => cancelDialog?.onConfirm?.());

    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: -32602 } });
  });
});

describe('ReactUIHandler warns the owner on the connect screen', () => {
  const OWNER = {
    username: 'angelo.justan.id',
    creationDate: '2026-01-01T00:00:00.000Z',
    credentialId: 'owner-credential',
    isImported: false,
    publicKey: `0x${'cc'.repeat(64)}` as Hex,
    address: ACCOUNT,
  };
  const openConnect = () => send('wallet_connect', { chainId: 84_532 });
  const reviewButton = () =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Review and cancel');

  beforeEach(() => {
    storedAccounts.mockReturnValue([OWNER]);
  });

  it('shows no warning while nobody is recovering the account', async () => {
    await openConnect();

    expect(listCeremonies).toHaveBeenCalledWith(ACCOUNT, { pending: true }, 'test-key');
    expect(onboarding?.notice).toBeUndefined();
    expect(document.body.textContent).not.toContain('Someone is recovering this account');
  });

  it('warns about a pending request, and "Review and cancel" opens the veto for the newest', async () => {
    listCeremonies.mockResolvedValue([
      entry(OLDER_ID, '2026-11-03T09:00:00.000Z'),
      entry(REQUEST_ID, '2026-11-04T14:36:00.000Z'),
    ]);
    await openConnect();

    expect(document.body.textContent).toContain('Someone is recovering this account');
    expect(document.body.textContent).toContain('A new passkey was requested for angelo.justan.id');
    expect(cancelDialog).toBeNull();

    await act(async () => reviewButton()?.click());
    expect(getCeremony).toHaveBeenCalledWith(REQUEST_ID, 'test-key');
    expect(cancelDialog?.ceremony?.requestId).toBe(REQUEST_ID);
  });

  it('vetoes with the passkey stored here, prompting only to sign, and goes back to the connect', async () => {
    listCeremonies.mockResolvedValue([entry(REQUEST_ID, '2026-11-04T14:36:00.000Z')]);
    getCeremony.mockResolvedValue(ceremony(REQUEST_ID, [chain(84_532, 'REQUESTED')]));
    cancelRecovery.mockResolvedValue({ door: 'relay', chains: [] });
    const { isSettled } = await openConnect();
    await act(async () => reviewButton()?.click());
    await act(async () => cancelDialog?.onConfirm?.());

    expect(restoreAccount).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 84_532, apiKey: 'test-key' }),
      'owner-credential',
      OWNER.publicKey
    );
    expect(cancelRecovery).toHaveBeenCalledWith(REQUEST_ID);
    expect(isSettled()).toBe(false);

    onboarding = null;
    await act(async () => cancelDialog?.onDone?.({ door: 'relay', chains: [] }));
    expect(onboarding).not.toBeNull();
    // Its cancel may still be landing: the vetoed request is not warned about again.
    expect(document.body.textContent).not.toContain('Someone is recovering this account');
  });

  it('keeps a failed veto on screen with the connect still open', async () => {
    listCeremonies.mockResolvedValue([entry(REQUEST_ID, '2026-11-04T14:36:00.000Z')]);
    cancelRecovery.mockRejectedValue(new Error('relayer down'));
    const { isSettled } = await openConnect();
    await act(async () => reviewButton()?.click());
    await act(async () => cancelDialog?.onConfirm?.());

    expect(cancelDialog?.error).toMatch(/relayer down/);
    expect(isSettled()).toBe(false);
  });
});

describe('ReactUIHandler starts a recovery from the connect screen', () => {
  it('links guardians to the page the SDK handed over in init', async () => {
    await send('wallet_connect', { chainId: 84_532 }, { recoveryApproveUrl: 'https://app.example/guardians' });
    await act(async () => onboarding?.onLostPasskey?.());

    expect(startDialog?.approveUrl).toBe('https://app.example/guardians');
  });

  it('tells the status which network the recovered passkey signs in on', async () => {
    await send('wallet_connect', { chainId: 84_532 });
    await act(async () => onboarding?.onLostPasskey?.());

    expect(startDialog?.chainId).toBe(84_532);
  });
});

// @vitest-environment jsdom
// The three recovery ceremony requests, through the component that answers them: each answers its
// request exactly once, with what the dApp's method returns, and a cancelled passkey prompt is the
// user's no (4001). The dialogs are stubbed and driven through their props; the signing account
// is a stub whose calls are counted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Account, SIGNATURE_RECOVERY_PROVIDER_ADDRESS, standardErrorCodes, type Ceremony } from '@jaw.id/core';
import type { Address, Hex } from 'viem';

type Props = Record<string, unknown> & { [key: string]: unknown };
const dialogs: Record<'start' | 'approve' | 'cancel', Props | null> = { start: null, approve: null, cancel: null };
let ceremony: Ceremony | null = null;

vi.mock('@jaw.id/ui', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/ui')>();
  return {
    ...actual,
    RecoveryStartDialog: (props: Props) => {
      dialogs.start = props;
      return null;
    },
    GuardianApproveDialog: (props: Props) => {
      dialogs.approve = props;
      return null;
    },
    RecoveryCancelDialog: (props: Props) => {
      dialogs.cancel = props;
      return null;
    },
    useRecoveryRequest: () => ({ ceremony, failed: false, settled: false }),
    usePendingRecoveries: () => null,
  };
});

const approveRecovery = vi.fn();
const cancelRecovery = vi.fn();
const GUARDIAN_ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
let signedInKey: Hex | null = null;
vi.mock('../../hooks', () => ({
  useSessionAccount: () => ({
    account: { approveRecovery, cancelRecovery },
    isLoading: false,
    walletAddress: GUARDIAN_ADDRESS,
    isAuthenticated: true,
  }),
  useAuth: () => ({ publicKey: signedInKey }),
  usePasskeyLogin: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { RequestModals } = await import('./index');
const { SDKRequestType } = await import('../../lib/sdk-types');

const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address;
const REQUEST_ID = `0x${'ab'.repeat(32)}` as Hex;
const GUARDIAN_KEY = `0x${'44'.repeat(64)}` as Hex;
const CREATED = {
  requestId: REQUEST_ID,
  account: ACCOUNT,
  subject: `0x${'55'.repeat(64)}` as Hex,
  salt: `0x${'22'.repeat(32)}` as Hex,
  expiry: '2030-01-01T00:00:00.000Z',
};
const COLLECTING: Ceremony = {
  ...CREATED,
  createdAt: '2029-12-01T00:00:00.000Z',
  threshold: 2,
  collected: 0,
  guardians: [
    {
      recoveryId: `0x${'0a'.repeat(32)}`,
      provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
      commitment: GUARDIAN_KEY,
      delay: 172_800,
      approvedAt: null,
    },
  ],
  chains: [{ chainId: 84532, status: 'COLLECTING', executeAt: null, requestTxHash: null, executeTxHash: null }],
};

const notAllowed = () =>
  Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });

let root: Root;
let container: HTMLDivElement;
let onApprove: ReturnType<typeof vi.fn>;
let onReject: ReturnType<typeof vi.fn>;
let scheduleClose: ReturnType<typeof vi.fn>;

async function open(type: (typeof SDKRequestType)[keyof typeof SDKRequestType], method: string, params: unknown[]) {
  await act(async () => {
    root.render(
      <RequestModals
        pendingRequest={{
          origin: 'https://dapp.example',
          type,
          requestId: 'req-1',
          correlationId: 'corr-1',
          metadata: { appName: 'Dapp', appLogoUrl: '' },
          method,
          params,
          chain: { id: 84532, rpcUrl: 'https://rpc.example?api-key=test-key' },
          onApprove,
          onReject,
        }}
        communicator={{ requestClose: vi.fn() } as never}
        apiKey="test-key"
        currentOrigin="https://dapp.example"
        txData={null}
        setPhase={vi.fn()}
        setError={vi.fn()}
        scheduleClose={scheduleClose}
        finishDeliveredFlow={vi.fn()}
        closeDelayMs={300}
        signDelivered={false}
      />
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  dialogs.start = dialogs.approve = dialogs.cancel = null;
  ceremony = COLLECTING;
  signedInKey = GUARDIAN_KEY;
  approveRecovery.mockReset();
  cancelRecovery.mockReset();
  onApprove = vi.fn(async () => undefined);
  onReject = vi.fn(async () => undefined);
  scheduleClose = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('wallet_startRecovery', () => {
  const PARAMS = [{ account: ACCOUNT, approveUrl: 'https://app.example/guardians' }];

  it('makes the passkey on keys, answers once with the request as created, and keeps the status until Done', async () => {
    const start = vi
      .spyOn(Account, 'startRecovery')
      .mockResolvedValue({ ...CREATED, credentialId: 'cred-new', publicKey: `0x${'66'.repeat(64)}` });
    await open(SDKRequestType.START_RECOVERY, 'wallet_startRecovery', PARAMS);

    expect(dialogs.start?.account).toBe(ACCOUNT);
    expect(dialogs.start?.approveUrl).toBe('https://app.example/guardians');

    const onStart = dialogs.start?.onStart as (account: Address, username: string) => Promise<void>;
    await act(async () => {
      // A second tap while the first is in flight opens nothing more.
      await Promise.all([onStart(ACCOUNT, 'alice.eth'), onStart(ACCOUNT, 'alice.eth')]);
    });

    expect(start).toHaveBeenCalledTimes(1);
    const [config, options] = start.mock.calls[0];
    // keys' own domain, never the dApp's.
    expect(config.rpId).toBe(window.location.hostname);
    expect(config.rpId).not.toBe('dapp.example');
    expect(options).toEqual({ account: ACCOUNT, username: 'alice.eth' });

    // What the method returns: the request, not the new passkey's details.
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(CREATED);
    expect(dialogs.start?.requestId).toBe(REQUEST_ID);
    expect(scheduleClose).not.toHaveBeenCalled();

    // Done, or closing the status, only closes: the dApp already has its answer.
    await act(async () => (dialogs.start?.onDone as () => void)());
    await act(async () => (dialogs.start?.onClose as () => void)());
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(scheduleClose).toHaveBeenCalled();
  });

  it('rejects with 4001 when the passkey prompt is cancelled', async () => {
    vi.spyOn(Account, 'startRecovery').mockRejectedValue(notAllowed());
    await open(SDKRequestType.START_RECOVERY, 'wallet_startRecovery', PARAMS);

    await act(async () => (dialogs.start?.onStart as (a: Address, u: string) => Promise<void>)(ACCOUNT, 'alice.eth'));

    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0][1]).toBe(standardErrorCodes.provider.userRejectedRequest);
  });

  it("links guardians to keys' own page when the request names none", async () => {
    await open(SDKRequestType.START_RECOVERY, 'wallet_startRecovery', []);

    expect(dialogs.start?.account).toBeUndefined();
    expect(dialogs.start?.approveUrl).toBe(`${window.location.origin}/recover/approve`);
  });

  it('closing before anything started is a 4001', async () => {
    await open(SDKRequestType.START_RECOVERY, 'wallet_startRecovery', PARAMS);

    await act(async () => (dialogs.start?.onClose as () => void)());

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0][1]).toBe(standardErrorCodes.provider.userRejectedRequest);
  });
});

describe('wallet_approveRecovery', () => {
  const PARAMS = [{ requestId: REQUEST_ID }];
  const APPROVAL = { collected: 1, threshold: 2, queued: false };

  it('approves the request on screen once, by its id, and answers with the approval', async () => {
    approveRecovery.mockResolvedValue(APPROVAL);
    await open(SDKRequestType.APPROVE_RECOVERY, 'wallet_approveRecovery', PARAMS);

    expect(dialogs.approve?.block).toBeNull();
    expect(dialogs.approve?.guardian).toBe(GUARDIAN_ADDRESS);

    const approve = dialogs.approve?.onApprove as () => Promise<void>;
    await act(async () => {
      await Promise.all([approve(), approve()]);
    });

    expect(approveRecovery).toHaveBeenCalledTimes(1);
    expect(approveRecovery).toHaveBeenCalledWith(REQUEST_ID);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(APPROVAL);
    expect(dialogs.approve?.approval).toEqual(APPROVAL);

    await act(async () => (dialogs.approve?.onDone as () => void)());
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(scheduleClose).toHaveBeenCalled();
  });

  it('rejects with 4001 when the passkey prompt is cancelled', async () => {
    approveRecovery.mockRejectedValue(notAllowed());
    await open(SDKRequestType.APPROVE_RECOVERY, 'wallet_approveRecovery', PARAMS);

    await act(async () => (dialogs.approve?.onApprove as () => Promise<void>)());

    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0][1]).toBe(standardErrorCodes.provider.userRejectedRequest);
  });

  it('refuses a signed-in key that is no guardian before any prompt, and answers -32602', async () => {
    signedInKey = `0x${'99'.repeat(64)}`;
    await open(SDKRequestType.APPROVE_RECOVERY, 'wallet_approveRecovery', PARAMS);

    expect(dialogs.approve?.block).toBe('not-guardian');
    await act(async () => (dialogs.approve?.onApprove as () => Promise<void>)());
    expect(approveRecovery).not.toHaveBeenCalled();

    await act(async () => (dialogs.approve?.onCancel as () => void)());
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0][1]).toBe(standardErrorCodes.rpc.invalidParams);
  });
});

describe('wallet_cancelRecovery', () => {
  const PARAMS = [{ requestId: REQUEST_ID }];
  const RESULT = { door: 'relay', batchId: 'batch-1', chains: [] };

  it('cancels the request on screen once, by its id, and answers with the outcome', async () => {
    cancelRecovery.mockResolvedValue(RESULT);
    await open(SDKRequestType.CANCEL_RECOVERY, 'wallet_cancelRecovery', PARAMS);

    const confirm = dialogs.cancel?.onConfirm as () => Promise<void>;
    await act(async () => {
      await Promise.all([confirm(), confirm()]);
    });

    expect(cancelRecovery).toHaveBeenCalledTimes(1);
    expect(cancelRecovery).toHaveBeenCalledWith(REQUEST_ID);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(RESULT);
    expect(dialogs.cancel?.result).toEqual(RESULT);

    await act(async () => (dialogs.cancel?.onDone as (r: unknown) => void)(RESULT));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(scheduleClose).toHaveBeenCalled();
  });

  it('rejects with 4001 when the passkey prompt is cancelled', async () => {
    cancelRecovery.mockRejectedValue(notAllowed());
    await open(SDKRequestType.CANCEL_RECOVERY, 'wallet_cancelRecovery', PARAMS);

    await act(async () => (dialogs.cancel?.onConfirm as () => Promise<void>)());

    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0][1]).toBe(standardErrorCodes.provider.userRejectedRequest);
  });
});

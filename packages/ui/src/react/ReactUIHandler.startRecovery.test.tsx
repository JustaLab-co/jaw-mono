// @vitest-environment jsdom
// The recovering user in App-Specific mode. `wallet_startRecovery` creates a new passkey on this
// site and opens the request; the dApp gets the request the moment it exists and the status stays
// on screen. From the connect screen, "Lost your passkey?" runs the same flow with the connect
// still open, and a passkey a recovery added that signs in before it finished sees its request.
//
// The dialogs are stubbed rather than driven through their buttons, as in the setup test: what is
// under test is what the wrappers start, look up and settle.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { RecoveryNotFinishedError, type CeremonyListEntry, type StartedRecovery } from '@jaw.id/core';
import type { Address, Hex } from 'viem';

const startRecovery = vi.fn();
const importAccount = vi.fn();
const listCeremonies = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/core')>();
  return {
    ...actual,
    Account: {
      startRecovery: (...args: unknown[]) => startRecovery(...args),
      import: (...args: unknown[]) => importAccount(...args),
      getStoredAccounts: () => [],
      getCurrentAccount: () => null,
      getAuthenticatedAddress: () => null,
      backfillStoredAccountAddresses: async () => [],
    },
    listCeremonies: (...args: unknown[]) => listCeremonies(...args),
  };
});
vi.mock('../hooks/useChainIconURI', () => ({ useChainIconURI: () => null }));

type StartDialogProps = {
  account?: Address;
  approveUrl?: string;
  requestId?: Hex | null;
  error?: string;
  onStart?: (account: Address, username: string) => Promise<void>;
  onClose?: () => void;
  onDone?: () => void;
  onBack?: () => void;
  onOpenAccount?: () => Promise<void>;
};
/** Props the wrapper hands the start dialog on the last render; null while it is not shown. */
let startDialog: StartDialogProps | null = null;
vi.mock('../components/RecoveryStartDialog', () => ({
  RecoveryStartDialog: (props: StartDialogProps) => {
    startDialog = props;
    return null;
  },
}));

type OnboardingProps = { onImportAccount?: () => Promise<void>; onLostPasskey?: () => void };
let onboarding: OnboardingProps | null = null;
vi.mock('../components/OnboardingDialog', () => ({
  OnboardingDialog: (props: OnboardingProps) => {
    onboarding = props;
    return null;
  },
}));

const { ReactUIHandler } = await import('./ReactUIHandler');

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const NEW_KEY = `0x${'ab'.repeat(64)}` as Hex;
const REQUEST_ID = `0x${'7f'.repeat(32)}` as Hex;
const STARTED: StartedRecovery = {
  requestId: REQUEST_ID,
  account: ACCOUNT,
  subject: NEW_KEY,
  salt: `0x${'01'.repeat(32)}`,
  expiry: '2026-12-04T12:00:00.000Z',
  credentialId: 'new-credential',
  publicKey: NEW_KEY,
};

function handler() {
  const instance = new ReactUIHandler();
  (instance as unknown as { config: Record<string, unknown> }).config = {
    apiKey: 'test-key',
    defaultChainId: 84_532,
    paymasters: {},
  };
  return instance;
}

/** Send a request to the handler and return the dApp's pending answer. */
async function send(type: string, data: Record<string, unknown>) {
  let answer!: Promise<unknown>;
  await act(async () => {
    answer = handler().request({ id: `req-${type}`, type, data } as Parameters<ReactUIHandler['request']>[0]);
  });
  let settled = false;
  void answer.then(() => (settled = true));
  // Wrapped: an async function returning the pending answer would wait for it to settle.
  return { answer, isSettled: () => settled };
}

const openStart = () =>
  send('wallet_startRecovery', { account: ACCOUNT, chainId: 84_532, approveUrl: 'https://app.example/approve' });
const openConnect = () => send('wallet_connect', { chainId: 84_532 });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  startRecovery.mockReset();
  startRecovery.mockResolvedValue(STARTED);
  importAccount.mockReset();
  listCeremonies.mockReset();
  startDialog = null;
  onboarding = null;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReactUIHandler starts a recovery for wallet_startRecovery', () => {
  it('opens on the account the app named, with the app’s guardian page', async () => {
    await openStart();

    expect(startDialog?.account).toBe(ACCOUNT);
    expect(startDialog?.approveUrl).toBe('https://app.example/approve');
  });

  it('creates the passkey on this site, for the account and name the screen hands on', async () => {
    await openStart();
    await act(async () => startDialog?.onStart?.(ACCOUNT, 'alice.justan.id'));

    expect(startRecovery).toHaveBeenCalledTimes(1);
    expect(startRecovery.mock.calls[0]).toEqual([
      expect.objectContaining({ chainId: 84_532, apiKey: 'test-key', rpId: 'localhost', rpName: 'JAW' }),
      { account: ACCOUNT, username: 'alice.justan.id' },
    ]);
  });

  it('answers with the created request as soon as it exists, and keeps its status on screen', async () => {
    const { answer } = await openStart();
    await act(async () => startDialog?.onStart?.(ACCOUNT, 'alice.justan.id'));

    // The request as created, without the new passkey's details.
    const created = {
      requestId: STARTED.requestId,
      account: STARTED.account,
      subject: STARTED.subject,
      salt: STARTED.salt,
      expiry: STARTED.expiry,
    };
    await expect(answer).resolves.toEqual({ id: 'req-wallet_startRecovery', approved: true, data: created });
    expect(startDialog?.requestId).toBe(REQUEST_ID);
    expect(document.querySelector('[data-jaw-modal-container]')).not.toBeNull();
  });

  it('starts once however fast the button is pressed', async () => {
    await openStart();
    await act(async () => {
      void startDialog?.onStart?.(ACCOUNT, 'alice.justan.id');
      void startDialog?.onStart?.(ACCOUNT, 'alice.justan.id');
    });

    expect(startRecovery).toHaveBeenCalledTimes(1);
  });

  it('closes on Done without answering again', async () => {
    const { answer } = await openStart();
    await act(async () => startDialog?.onStart?.(ACCOUNT, 'alice.justan.id'));
    await act(async () => startDialog?.onDone?.());

    await expect(answer).resolves.toMatchObject({ approved: true, data: { requestId: REQUEST_ID } });
    expect(document.querySelector('[data-jaw-modal-container]')).toBeNull();
  });

  it('rejects with 4001 when the passkey prompt is cancelled', async () => {
    startRecovery.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    const { answer } = await openStart();
    await act(async () => startDialog?.onStart?.(ACCOUNT, 'alice.justan.id'));

    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
  });

  it('rejects with 4001 when closed before anything started', async () => {
    const { answer } = await openStart();
    await act(async () => startDialog?.onClose?.());

    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
    expect(startRecovery).not.toHaveBeenCalled();
  });
});

describe('ReactUIHandler runs the recovery from the connect screen', () => {
  it('opens the start flow from "Lost your passkey?", with keys’ guardian page', async () => {
    await openConnect();
    await act(async () => onboarding?.onLostPasskey?.());

    expect(startDialog).not.toBeNull();
    expect(startDialog?.account).toBeUndefined();
    expect(startDialog?.approveUrl).toBe('https://keys.jaw.id/recover/approve');
  });

  it('shows the status of the request it starts and keeps the connect open; Done ends it as cancelled', async () => {
    const { answer, isSettled } = await openConnect();
    await act(async () => onboarding?.onLostPasskey?.());
    await act(async () => startDialog?.onStart?.(ACCOUNT, 'alice.justan.id'));

    expect(startDialog?.requestId).toBe(REQUEST_ID);
    expect(isSettled()).toBe(false);

    await act(async () => startDialog?.onDone?.());
    await expect(answer).resolves.toMatchObject({ approved: false, error: { code: 4001 } });
  });

  it('keeps the connect open with the error on screen when the start fails', async () => {
    startRecovery.mockRejectedValue(new Error('backend down'));
    const { isSettled } = await openConnect();
    await act(async () => onboarding?.onLostPasskey?.());
    await act(async () => startDialog?.onStart?.(ACCOUNT, 'alice.justan.id'));

    expect(startDialog?.error).toMatch(/backend down/);
    expect(isSettled()).toBe(false);
  });

  it('goes back to the sign-in screen on Back', async () => {
    await openConnect();
    await act(async () => onboarding?.onLostPasskey?.());
    const back = startDialog?.onBack;
    onboarding = null;
    await act(async () => back?.());

    expect(onboarding).not.toBeNull();
  });
});

describe('ReactUIHandler signs in with a recovered passkey', () => {
  const entry = (requestId: Hex, subject: Hex): CeremonyListEntry => ({
    requestId,
    account: ACCOUNT,
    subject,
    expiry: '2026-12-04T12:00:00.000Z',
    createdAt: '2026-11-04T12:00:00.000Z',
    chains: [{ chainId: 84_532, status: 'COLLECTING', executeAt: null, requestTxHash: null, executeTxHash: null }],
  });

  it('shows the status of the request whose subject is the passkey, when the recovery has not finished', async () => {
    importAccount.mockRejectedValue(new RecoveryNotFinishedError(ACCOUNT, 84_532, NEW_KEY));
    listCeremonies.mockResolvedValue([
      entry(`0x${'11'.repeat(32)}`, `0x${'cd'.repeat(64)}`),
      entry(REQUEST_ID, NEW_KEY.toUpperCase().replace('0X', '0x') as Hex),
    ]);
    const { isSettled } = await openConnect();
    await act(async () => onboarding?.onImportAccount?.());

    expect(listCeremonies).toHaveBeenCalledWith(ACCOUNT, undefined, 'test-key');
    expect(startDialog?.requestId).toBe(REQUEST_ID);
    expect(startDialog?.account).toBe(ACCOUNT);
    expect(isSettled()).toBe(false);
  });

  it('stays on the sign-in screen for any other sign-in failure', async () => {
    importAccount.mockRejectedValue(new Error('cancelled'));
    await openConnect();
    await act(async () => onboarding?.onImportAccount?.());

    expect(listCeremonies).not.toHaveBeenCalled();
    expect(startDialog).toBeNull();
  });

  it('answers the connect with the account once "Open my account" signs in with the new passkey', async () => {
    importAccount
      .mockRejectedValueOnce(new RecoveryNotFinishedError(ACCOUNT, 84_532, NEW_KEY))
      .mockResolvedValue({ address: ACCOUNT, getMetadata: () => ({ username: 'alice.justan.id' }) });
    listCeremonies.mockResolvedValue([entry(REQUEST_ID, NEW_KEY)]);
    const { answer } = await openConnect();
    await act(async () => onboarding?.onImportAccount?.());
    await act(async () => startDialog?.onOpenAccount?.());

    await expect(answer).resolves.toMatchObject({ approved: true, data: { accounts: [{ address: ACCOUNT }] } });
  });
});

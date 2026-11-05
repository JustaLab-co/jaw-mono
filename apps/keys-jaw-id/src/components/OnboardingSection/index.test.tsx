// @vitest-environment jsdom
// The connect screen's ways into a recovery: "Lost your passkey?" swaps the screen to the start
// flow inside the open request, a passkey a recovery added signing in early shows that request's
// status, and the owner's warning opens the veto. The dialogs are stubbed and driven through their
// props; the recovery backend is faked at the network edge, so core's own client runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, type ReactNode } from 'react';
import axios, { type AxiosAdapter } from 'axios';
import { RecoveryNotFinishedError, type CeremonyListEntry, type PasskeyAccount } from '@jaw.id/core';
import type { Address, Hex } from 'viem';

type Props = Record<string, unknown>;
const dialogs: Record<'onboarding' | 'start' | 'cancel', Props | null> = {
  onboarding: null,
  start: null,
  cancel: null,
};
let pending: CeremonyListEntry[] | null = null;

vi.mock('@jaw.id/ui', async (importActual) => {
  const actual = await importActual<typeof import('@jaw.id/ui')>();
  return {
    ...actual,
    OnboardingDialog: (props: Props) => {
      dialogs.onboarding = props;
      return <div data-testid="onboarding">{props.notice as ReactNode}</div>;
    },
    RecoveryStartDialog: (props: Props) => {
      dialogs.start = props;
      return <div data-testid="start" />;
    },
    RecoveryCancelDialog: (props: Props) => {
      dialogs.cancel = props;
      return <div data-testid="cancel" />;
    },
    useRecoveryRequest: () => ({ ceremony: null, failed: false, settled: false }),
    usePendingRecoveries: (account: Address | undefined) => (account ? pending : null),
    useReverseIdentity: () => ({ name: null, plainName: null, avatar: null }),
  };
});

const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address;
const STORED: PasskeyAccount = {
  username: 'alice',
  credentialId: 'cred-alice',
  publicKey: `0x${'44'.repeat(64)}`,
  address: ACCOUNT,
  creationDate: '2026-01-01T00:00:00.000Z',
  isImported: false,
};
const passkeyLogin = vi.fn();
const restoreAccount = vi.fn();
vi.mock('../../hooks', () => ({
  usePasskeys: () => ({ accounts: [STORED], accountsLoading: false, refetchAccounts: vi.fn(), restoreAccount }),
  useLogin: () => ({ mutateAsync: vi.fn() }),
  usePasskeyLogin: () => ({ mutateAsync: passkeyLogin, isPending: false }),
  useCreatePasskey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAuth: () => ({ refetch: vi.fn() }),
}));

const { SignInScreen } = await import('./index');

const NEW_KEY = `0x${'66'.repeat(64)}` as Hex;
const REQUEST_ID = `0x${'ab'.repeat(32)}` as Hex;

let root: Root;
let container: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn>;

async function render(extra: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      <SignInScreen
        onComplete={vi.fn()}
        onClose={onClose}
        chainId={11155111}
        apiKey="test-key"
        chainConfig={{ id: 84532, rpcUrl: 'https://rpc.example' }}
        origin="https://dapp.example"
        {...extra}
      />
    );
  });
}

// The recovery backend, at the network edge.
const original = axios.defaults.adapter;
let listed: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  dialogs.onboarding = dialogs.start = dialogs.cancel = null;
  pending = null;
  listed = [];
  passkeyLogin.mockReset();
  restoreAccount.mockReset();
  onClose = vi.fn();
  const backend: AxiosAdapter = async (request) => {
    if (request.method === 'get' && request.url === '/recovery/v2/ceremonies') {
      listed.push(String((request.params as { account?: string }).account));
      const ceremonies = [
        { requestId: `0x${'cd'.repeat(32)}`, account: ACCOUNT, subject: `0x${'77'.repeat(64)}` },
        { requestId: REQUEST_ID, account: ACCOUNT, subject: NEW_KEY },
      ];
      return {
        data: { result: { data: { ceremonies }, error: null } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: request,
      };
    }
    throw new Error(`unexpected ${request.method} ${request.url}`);
  };
  axios.defaults.adapter = backend;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  axios.defaults.adapter = original;
  vi.unstubAllGlobals();
});

describe('"Lost your passkey?"', () => {
  it('swaps the connect screen to the start flow, and Done declines the request', async () => {
    await render();

    await act(async () => (dialogs.onboarding?.onLostPasskey as () => void)());

    expect(container.querySelector('[data-testid="start"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="onboarding"]')).toBeNull();
    // Nothing named yet: the first screen asks which account.
    expect(dialogs.start?.account).toBeUndefined();
    expect(dialogs.start?.requestId).toBeFalsy();
    expect(dialogs.start?.approveUrl).toBe(`${window.location.origin}/recover/approve`);

    // Back returns to the sign-in screen with the request still open.
    await act(async () => (dialogs.start?.onBack as () => void)());
    expect(container.querySelector('[data-testid="onboarding"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => (dialogs.onboarding?.onLostPasskey as () => void)());
    await act(async () => (dialogs.start?.onDone as () => void)());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('switches to the popup instead where the embedded dialog cannot create a passkey (Safari)', async () => {
    const switchToPopup = vi.fn();
    await render({ onCreateNewAccount: switchToPopup });

    expect(dialogs.onboarding?.onLostPasskey).toBe(switchToPopup);
  });
});

describe('a passkey a recovery added, signing in before it finished', () => {
  it("shows that request's status, on the sign-in network", async () => {
    passkeyLogin.mockRejectedValue(new RecoveryNotFinishedError(ACCOUNT, 84532, NEW_KEY));
    await render();

    await act(async () => (dialogs.onboarding?.onImportAccount as () => Promise<void>)());

    expect(listed).toEqual([ACCOUNT]);
    expect(container.querySelector('[data-testid="start"]')).not.toBeNull();
    // The request whose subject is the key that signed in, not the account's other one.
    expect(dialogs.start?.requestId).toBe(REQUEST_ID);
    expect(dialogs.start?.account).toBe(ACCOUNT);
    expect(dialogs.start?.chainId).toBe(84532);
  });

  it('leaves any other sign-in failure on the sign-in screen', async () => {
    passkeyLogin.mockRejectedValue(new Error('No stored passkey found or authentication failed'));
    await render();

    await act(async () => (dialogs.onboarding?.onImportAccount as () => Promise<void>)());

    expect(listed).toEqual([]);
    expect(container.querySelector('[data-testid="onboarding"]')).not.toBeNull();
  });
});

describe("the owner's warning", () => {
  it('shows on the connect screen while someone recovers the account, and opens the veto', async () => {
    pending = [
      {
        requestId: REQUEST_ID,
        account: ACCOUNT,
        subject: NEW_KEY,
        expiry: '2030-01-01T00:00:00.000Z',
        createdAt: '2029-12-01T00:00:00.000Z',
        chains: [],
      },
    ];
    const cancelRecovery = vi.fn().mockResolvedValue({ door: 'relay', chains: [] });
    restoreAccount.mockResolvedValue({ cancelRecovery });
    await render();

    const review = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Review and cancel');
    expect(review).toBeDefined();
    await act(async () => review?.click());

    expect(container.querySelector('[data-testid="cancel"]')).not.toBeNull();
    await act(async () => (dialogs.cancel?.onConfirm as () => Promise<void>)());

    // The stored passkey, restored with no prompt, cancels exactly the request warned about.
    expect(restoreAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: 84532 }),
      STORED.credentialId,
      STORED.publicKey,
      'test-key'
    );
    expect(cancelRecovery).toHaveBeenCalledWith(REQUEST_ID);
    // The request is still open: nothing was answered.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is not shown when nobody is recovering the account', async () => {
    pending = [];
    await render();

    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Review and cancel')).toBe(false);
  });
});

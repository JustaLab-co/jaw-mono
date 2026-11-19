// @vitest-environment jsdom
// A request names the account it is for. The popup signs with the passkey the app connected with,
// so a request for an account that passkey can't sign for is refused before its screen opens,
// instead of opening a screen that can only fail. Each screen is stubbed: what is under test is
// which one the popup shows and what the app is told.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { standardErrors } from '@jaw.id/core';
import { createSiweMessage } from 'viem/siwe';

import { SDKRequestType } from '../../lib/sdk-types';
import type { PendingRequest } from '../../utils/types';
import type { TransactionRequestData } from '../TransactionModal';

/** The account the app connected with: passkey B's own. */
const CONNECTED = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
/** An account passkey B doesn't own. */
const NOT_OWNED = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** Another account passkey B is an owner of. */
const CO_OWNED = '0xcccccccccccccccccccccccccccccccccccccccc';

const world = {
  owned: new Set<string>(),
  offline: false,
  restoreFailed: false,
  /** Core's owner lookup never answers, as on a slow network. */
  checkHangs: false,
  /** The connected account's name, if it has one. */
  connectedName: 'bee.justan.id' as string | null,
};

/** Passkey B restored for this app, resolving other accounts the way core does. */
const sessionAccount = {
  address: CONNECTED,
  getSmartAccountFor: async (address?: string) => {
    if (world.checkHangs) await new Promise(() => undefined);
    if (world.offline) throw new Error('fetch failed');
    if (!address || world.owned.has(address.toLowerCase())) return {};
    throw standardErrors.rpc.invalidParams(`Signer is not an owner on account ${address}`);
  },
};

vi.mock('../../hooks', () => ({
  useSessionAccount: () => ({
    account: world.restoreFailed ? null : sessionAccount,
    isLoading: false,
    error: world.restoreFailed ? new Error('restore failed') : null,
    walletAddress: CONNECTED,
    isAuthenticated: true,
  }),
}));

vi.mock('../TransactionModal', () => ({ TransactionModal: () => <div data-screen="transaction" /> }));
vi.mock('../PermissionModal', () => ({ PermissionModal: () => <div data-screen="permission" /> }));
vi.mock('../SignatureModal', () => ({ SignatureModal: () => <div data-screen="signature" /> }));
vi.mock('../SiweModal', () => ({ SiweModal: () => <div data-screen="siwe" /> }));
vi.mock('../Eip712Modal', () => ({ Eip712Modal: () => <div data-screen="typed-data" /> }));

const { RequestModals } = await import('./index');

const ORIGIN = 'https://app.example';
const CHAIN = { id: 8453, rpcUrl: 'https://rpc.example' };

let root: Root;
let container: HTMLDivElement;

function sendFrom(from: string | undefined, method: TransactionRequestData['method'] = 'wallet_sendCalls') {
  const pendingRequest: PendingRequest = {
    origin: ORIGIN,
    type: SDKRequestType.SEND_TRANSACTION,
    requestId: 'req-1',
    correlationId: 'corr-1',
    metadata: { appName: 'Example App' } as PendingRequest['metadata'],
    method,
    params: [{ from, calls: [{ to: NOT_OWNED, value: '0x0' }] }],
    chain: CHAIN,
    onApprove: vi.fn(async () => undefined),
    onReject: vi.fn(async () => undefined),
  };
  const txData: TransactionRequestData = {
    method,
    transactions: [{ to: NOT_OWNED, value: '0', chainId: CHAIN.id }],
    chainId: CHAIN.id,
    from: from as `0x${string}` | undefined,
  };
  return { pendingRequest, txData };
}

async function open({
  pendingRequest,
  txData,
}: {
  pendingRequest: PendingRequest;
  txData: TransactionRequestData | null;
}) {
  const communicator = { requestClose: vi.fn() };
  await act(async () => {
    root.render(
      <RequestModals
        pendingRequest={pendingRequest}
        communicator={communicator as never}
        apiKey="test-key"
        currentOrigin={ORIGIN}
        txData={txData}
        setPhase={vi.fn()}
        setError={vi.fn()}
        scheduleClose={vi.fn()}
        finishDeliveredFlow={vi.fn()}
        closeDelayMs={0}
        signDelivered={false}
        connectedAccount={{ address: CONNECTED, name: world.connectedName }}
      />
    );
  });
  // The ownership check is async.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { communicator };
}

const screenShown = (name: string) => container.querySelector(`[data-screen="${name}"]`) !== null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  world.owned = new Set([CONNECTED, CO_OWNED]);
  world.offline = false;
  world.restoreFailed = false;
  world.checkHangs = false;
  world.connectedName = 'bee.justan.id';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!button) throw new Error(`No "${label}" button`);
  return act(async () => button.click());
}

describe.each(['wallet_sendCalls', 'eth_sendTransaction'] as const)('RequestModals %s', (method) => {
  it('refuses a send for an account the connected passkey cannot sign for, instead of opening a send screen that can only fail', async () => {
    await open(sendFrom(NOT_OWNED, method));

    expect(screenShown('transaction')).toBe(false);
    expect(container.textContent).toContain('This request is for 0xaaaa...aaaa');
    expect(container.textContent).toContain('Example App is connected as bee.justan.id');
  });

  it('tells the app the account is not connected when the refusal is closed, and closes', async () => {
    const request = sendFrom(NOT_OWNED, method);
    const { communicator } = await open(request);

    await click('Close');

    expect(request.pendingRequest.onReject).toHaveBeenCalledWith(expect.stringContaining(NOT_OWNED), 4100);
    expect(request.pendingRequest.onApprove).not.toHaveBeenCalled();
    expect(communicator.requestClose).toHaveBeenCalledTimes(1);
  });

  it('opens the send screen for the connected account', async () => {
    await open(sendFrom(CONNECTED, method));
    expect(screenShown('transaction')).toBe(true);
  });

  it('opens the send screen for another account the connected passkey owns', async () => {
    await open(sendFrom(CO_OWNED, method));
    expect(screenShown('transaction')).toBe(true);
  });

  it('opens the send screen when the request names no account', async () => {
    await open(sendFrom(undefined, method));
    expect(screenShown('transaction')).toBe(true);
  });

  it('opens the send screen as before when the check itself fails, so a network error is not read as the wrong account', async () => {
    world.offline = true;
    await open(sendFrom(NOT_OWNED, method));
    expect(screenShown('transaction')).toBe(true);
    expect(container.textContent).not.toContain('This request is for');
  });
});

/** A request of `type` for `address`, shaped the way the SDK sends it. */
function requestFor(type: SDKRequestType, method: string, params: unknown[]) {
  const pendingRequest: PendingRequest = {
    origin: ORIGIN,
    type,
    requestId: `req-${method}`,
    correlationId: 'corr-1',
    metadata: { appName: 'Example App' } as PendingRequest['metadata'],
    method,
    params,
    chain: CHAIN,
    onApprove: vi.fn(async () => undefined),
    onReject: vi.fn(async () => undefined),
  };
  return { pendingRequest, txData: null };
}

const PERMISSIONS = [
  {
    name: 'wallet_grantPermissions',
    screen: 'permission',
    request: (address: string) =>
      requestFor(SDKRequestType.GRANT_PERMISSIONS, 'wallet_grantPermissions', [
        {
          address,
          spender: '0x2222222222222222222222222222222222222222',
          expiry: 2_000_000_000,
          permissions: { calls: [], spends: [] },
          chainId: '0x2105',
        },
      ]),
  },
  {
    name: 'wallet_revokePermissions',
    screen: 'permission',
    request: (address: string) =>
      requestFor(SDKRequestType.REVOKE_PERMISSIONS, 'wallet_revokePermissions', [
        { id: `0x${'ab'.repeat(32)}`, address },
      ]),
  },
];

const TYPED_DATA = {
  domain: { name: 'Example', version: '1', chainId: 8453 },
  types: { Mail: [{ name: 'contents', type: 'string' }] },
  primaryType: 'Mail',
  message: { contents: 'Hello' },
};

const SIGNS = [
  {
    name: 'personal_sign',
    screen: 'signature',
    request: (address: string) => requestFor(SDKRequestType.SIGN_MESSAGE, 'personal_sign', ['0x48656c6c6f', address]),
  },
  {
    name: 'wallet_sign 0x45',
    screen: 'signature',
    request: (address: string) =>
      requestFor(SDKRequestType.SIGN_MESSAGE, 'wallet_sign', [
        { request: { type: '0x45', data: { message: 'Hello' } }, address },
      ]),
  },
  {
    name: 'personal_sign with a SIWE message',
    screen: 'siwe',
    request: (address: string) =>
      requestFor(SDKRequestType.SIGN_MESSAGE, 'personal_sign', [
        createSiweMessage({
          address: address as `0x${string}`,
          chainId: CHAIN.id,
          domain: 'app.example',
          nonce: 'abcdefgh12',
          uri: ORIGIN,
          version: '1',
        }),
        address,
      ]),
  },
  {
    name: 'wallet_sign 0x45 with a SIWE message',
    screen: 'siwe',
    request: (address: string) =>
      requestFor(SDKRequestType.SIGN_MESSAGE, 'wallet_sign', [
        {
          request: {
            type: '0x45',
            data: {
              message: createSiweMessage({
                address: address as `0x${string}`,
                chainId: CHAIN.id,
                domain: 'app.example',
                nonce: 'abcdefgh12',
                uri: ORIGIN,
                version: '1',
              }),
            },
          },
          address,
        },
      ]),
  },
  {
    name: 'eth_signTypedData_v4',
    screen: 'typed-data',
    request: (address: string) =>
      requestFor(SDKRequestType.SIGN_TYPED_DATA, 'eth_signTypedData_v4', [address, JSON.stringify(TYPED_DATA)]),
  },
  {
    name: 'wallet_sign 0x01',
    screen: 'typed-data',
    request: (address: string) =>
      requestFor(SDKRequestType.SIGN_TYPED_DATA, 'wallet_sign', [
        { request: { type: '0x01', data: TYPED_DATA }, address },
      ]),
  },
];

describe.each([...PERMISSIONS, ...SIGNS])('RequestModals $name', ({ screen, request }) => {
  it('refuses it for an account the connected passkey cannot sign for', async () => {
    const opened = request(NOT_OWNED);
    const { communicator } = await open(opened);

    expect(screenShown(screen)).toBe(false);
    expect(container.textContent).toContain('This request is for 0xaaaa...aaaa');

    await click('Close');
    expect(opened.pendingRequest.onReject).toHaveBeenCalledWith(expect.stringContaining(NOT_OWNED), 4100);
    expect(communicator.requestClose).toHaveBeenCalledTimes(1);
  });

  it('opens its screen for the connected account and for one the passkey co-owns', async () => {
    await open(request(CONNECTED));
    expect(screenShown(screen)).toBe(true);

    await open(request(CO_OWNED));
    expect(screenShown(screen)).toBe(true);
  });
});

describe('RequestModals with a request that names no account', () => {
  it.each([SIGNS[1], PERMISSIONS[0]])('opens $name for the connected account', async ({ screen, request }) => {
    await open(request(undefined as unknown as string));
    expect(screenShown(screen)).toBe(true);
  });
});

describe('RequestModals when the connected passkey cannot be restored', () => {
  it('opens the screen as before, which reports the failure itself', async () => {
    world.restoreFailed = true;
    await open(sendFrom(NOT_OWNED));
    expect(screenShown('transaction')).toBe(true);
    expect(container.textContent).not.toContain('This request is for');
  });
});

describe('RequestModals refusing a request for an account the connected passkey cannot sign for', () => {
  it('names the connected account by its address when it has no name', async () => {
    world.connectedName = null;
    await open(sendFrom(NOT_OWNED));
    expect(container.textContent).toContain('Example App is connected as 0xbbbb...bbbb');
  });

  it('shows neither the screen nor the refusal while the check is still running', async () => {
    world.checkHangs = true;
    await open(sendFrom(NOT_OWNED));
    expect(screenShown('transaction')).toBe(false);
    expect(container.textContent).not.toContain('This request is for');
  });
});

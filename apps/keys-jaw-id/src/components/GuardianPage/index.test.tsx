// @vitest-environment jsdom
// The guardian page, rendered for real with the recovery backend faked at the network edge (core's
// own client runs) and the browser wallet faked as an injected provider that signs with a real
// key. The passkey path stubs only what WebAuthn would do: the stored account and its signature.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import {
  Account,
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  computeRecoveryId,
  computeRequestId,
  recoverTypedData,
  toOwnerBytes,
  type Ceremony,
  type CeremonyChain,
} from '@jaw.id/core';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { GuardianPage } from './index';

const ACCOUNT = '0x2FA8A6b6C0E3c1d6C2D3cB4C1f0d0B6b0e61C41d' as Address;
const SUBJECT = `0x${'44'.repeat(64)}` as Hex;
const SALT = `0x${'22'.repeat(32)}` as Hex;
const REQUEST_ID = computeRequestId(ACCOUNT, SUBJECT, SALT);
const API_KEY = 'keys-recovery-key';
// anvil's third default key: the wallet guardian
const WALLET_GUARDIAN = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
// anvil's fourth: a wallet that guards nothing
const STRANGER = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const PASSKEY_KEY = `0x${'51'.repeat(64)}` as Hex;
const PASSKEY_ACCOUNT = '0x3333333333333333333333333333333333333333' as Address;
const APPROVAL = { collected: 1, threshold: 2, queued: false };

const chain = (status: CeremonyChain['status']): CeremonyChain => ({
  chainId: 84532,
  status,
  executeAt: null,
  requestTxHash: null,
  executeTxHash: null,
});

function ceremony(status: CeremonyChain['status'] = 'COLLECTING'): Ceremony {
  return {
    requestId: REQUEST_ID,
    account: ACCOUNT,
    subject: SUBJECT,
    salt: SALT,
    expiry: '2030-01-01T00:00:00.000Z',
    createdAt: new Date().toISOString(),
    threshold: 2,
    collected: 0,
    guardians: [
      {
        recoveryId: computeRecoveryId(
          ACCOUNT,
          SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
          toOwnerBytes(WALLET_GUARDIAN.address)
        ),
        provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
        commitment: toOwnerBytes(WALLET_GUARDIAN.address),
        delay: 172_800,
        approvedAt: null,
      },
      {
        recoveryId: computeRecoveryId(ACCOUNT, SIGNATURE_RECOVERY_PROVIDER_ADDRESS, PASSKEY_KEY),
        provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
        commitment: PASSKEY_KEY,
        delay: 172_800,
        approvedAt: null,
      },
    ],
    chains: [chain(status)],
  };
}

// The recovery backend, at the network edge.
const original = axios.defaults.adapter;
let served: Ceremony;
let sent: InternalAxiosRequestConfig[];

// The injected browser wallet: shares one account and signs typed data with its real key.
let walletRequests: string[];
function installWallet(signer: ReturnType<typeof privateKeyToAccount>) {
  (window as unknown as { ethereum: unknown }).ethereum = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      walletRequests.push(method);
      if (method === 'eth_requestAccounts') return [signer.address];
      if (method === 'eth_signTypedData_v4') return signer.signTypedData(JSON.parse((params as [Address, string])[1]));
      throw new Error(`unexpected ${method}`);
    },
  };
}

let container: HTMLDivElement;
let root: Root;

/** Renders the page; `null` is a deployment with no key configured. */
async function show(apiKey: string | null = API_KEY) {
  await act(async () => root.render(<GuardianPage requestId={REQUEST_ID} apiKey={apiKey ?? undefined} />));
}

const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const checkAll = async () => {
  for (const box of [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]) {
    await act(async () => box.click());
  }
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // ENS lookups on mainnet: no names, the short addresses show.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  served = ceremony();
  sent = [];
  walletRequests = [];
  const backend: AxiosAdapter = async (request) => {
    sent.push(request);
    const reply = (data: unknown) => ({
      data: { result: { data, error: null } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: request,
    });
    if (request.method === 'get' && request.url === `/recovery/v2/ceremonies/${REQUEST_ID}`) return reply(served);
    if (request.method === 'get' && request.url === '/recovery/v2/ceremonies') return reply({ ceremonies: [served] });
    if (request.method === 'post' && request.url === `/recovery/v2/ceremonies/${REQUEST_ID}/approvals`) {
      return reply(APPROVAL);
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
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('guardian page', () => {
  it('says recovery approval is unavailable when no key is configured, and reads nothing', async () => {
    await show(null);

    expect(text()).toContain('Recovery approval is unavailable');
    expect(button('Approve with passkey')).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('shows a request that no longer takes approvals with no way to approve', async () => {
    served = ceremony('REQUESTED');
    await show();

    await vi.waitFor(() => expect(text()).toContain('This request can’t be approved any more'));
    expect(text()).toContain('Enough guardians already approved it.');
    expect(button('Approve with passkey')).toBeUndefined();
    expect(button('Approve with a wallet')).toBeUndefined();
  });

  it('turns the approve buttons on only once both checks are ticked', async () => {
    await show();
    await vi.waitFor(() => expect(button('Approve with passkey')).toBeDefined());

    expect(text()).toContain('Before you approve');
    expect(button('Approve with passkey')?.disabled).toBe(true);
    expect(button('Approve with a wallet')?.disabled).toBe(true);

    await checkAll();

    expect(button('Approve with passkey')?.disabled).toBe(false);
    expect(button('Approve with a wallet')?.disabled).toBe(false);
  });

  it('approves with a browser wallet: it signs the request on screen and the proof is posted with the key', async () => {
    installWallet(WALLET_GUARDIAN);
    await show();
    await vi.waitFor(() => expect(button('Approve with a wallet')).toBeDefined());
    await checkAll();

    await act(async () => button('Approve with a wallet')?.click());

    await vi.waitFor(() => expect(text()).toContain('You approved.'));
    expect(text()).toContain('1 of 2');
    expect(walletRequests).toEqual(['eth_requestAccounts', 'eth_signTypedData_v4']);

    const approval = sent.find((request) => request.method === 'post');
    expect(approval?.headers['x-api-key']).toBe(API_KEY);
    const body = JSON.parse(approval?.data as string) as { recoveryId: Hex; proof: Hex };
    expect(body.recoveryId).toBe(served.guardians[0].recoveryId);
    // The proof recovers to the wallet over core's Recover typed data for this request.
    const signer = await recoverTypedDataAddress({
      ...recoverTypedData({ account: ACCOUNT, subject: SUBJECT, salt: SALT, expiry: served.expiry }),
      signature: body.proof,
    });
    expect(signer).toBe(WALLET_GUARDIAN.address);
  });

  it('says a wallet that guards nothing is not a guardian, before it is asked to sign', async () => {
    installWallet(STRANGER);
    await show();
    await vi.waitFor(() => expect(button('Approve with a wallet')).toBeDefined());
    await checkAll();

    await act(async () => button('Approve with a wallet')?.click());

    await vi.waitFor(() => expect(text()).toContain('This account isn’t a guardian for this request'));
    expect(walletRequests).toEqual(['eth_requestAccounts']);
    expect(sent.some((request) => request.method === 'post')).toBe(false);
    expect(button('Back')).toBeDefined();
  });

  it('approves with a passkey stored here: signed in with no prompt, "Approving as", then one approve prompt', async () => {
    const approveRecovery = vi.fn().mockResolvedValue(APPROVAL);
    vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([
      {
        username: 'not-a-guardian',
        credentialId: 'cred-other',
        publicKey: `0x${'99'.repeat(64)}`,
        creationDate: '2026-01-01T00:00:00.000Z',
        isImported: false,
      },
      {
        username: 'ghadi',
        credentialId: 'cred-guardian',
        publicKey: PASSKEY_KEY,
        creationDate: '2026-01-01T00:00:00.000Z',
        isImported: false,
      },
    ]);
    const restore = vi
      .spyOn(Account, 'restore')
      .mockResolvedValue({ address: PASSKEY_ACCOUNT, getMetadata: () => null, approveRecovery } as never);
    const importAccount = vi.spyOn(Account, 'import');
    await show();
    await vi.waitFor(() => expect(button('Approve with passkey')).toBeDefined());
    await checkAll();

    await act(async () => button('Approve with passkey')?.click());

    // The stored guardian passkey, picked by its key, and no browser prompt to sign in.
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0].slice(1)).toEqual(['cred-guardian', PASSKEY_KEY]);
    expect(importAccount).not.toHaveBeenCalled();
    expect(text()).toContain('Approving as');
    expect(approveRecovery).not.toHaveBeenCalled();

    await act(async () => button('Approve')?.click());

    expect(approveRecovery).toHaveBeenCalledTimes(1);
    expect(approveRecovery).toHaveBeenCalledWith(REQUEST_ID);
    await vi.waitFor(() => expect(text()).toContain('You approved.'));
    // A full page has nothing to close.
    expect(button('Done')).toBeUndefined();
  });

  it('says a passkey that guards nothing is not a guardian, before its approve prompt', async () => {
    const approveRecovery = vi.fn();
    const stranger = {
      username: 'stranger',
      credentialId: 'cred-stranger',
      publicKey: `0x${'99'.repeat(64)}` as Hex,
      creationDate: '2026-01-01T00:00:00.000Z',
      isImported: false,
    };
    const stored = vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([]);
    vi.spyOn(Account, 'import').mockImplementation(async () => {
      stored.mockReturnValue([stranger]);
      return {
        address: PASSKEY_ACCOUNT,
        getMetadata: () => ({ credentialId: stranger.credentialId }),
        approveRecovery,
      } as never;
    });
    await show();
    await vi.waitFor(() => expect(button('Approve with passkey')).toBeDefined());
    await checkAll();

    await act(async () => button('Approve with passkey')?.click());

    await vi.waitFor(() => expect(text()).toContain('This account isn’t a guardian for this request'));
    expect(button('Approve')).toBeUndefined();
    expect(approveRecovery).not.toHaveBeenCalled();
  });
});

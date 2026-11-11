// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { Account, type UIRequest } from '@jaw.id/core';

import { ReactUIHandler } from './ReactUIHandler';

const ADZ = '0x00000000000000000000000000000000000000a1';
const JAWEGG = '0x00000000000000000000000000000000000000b2';
const CONNECT = { id: 'req-1', type: 'wallet_connect', data: { chainId: 1 } } as unknown as UIRequest;

const SILENT_CONNECT = {
  id: 'req-2',
  type: 'wallet_connect',
  data: { chainId: 1, silent: true },
} as unknown as UIRequest;

const stored = (username: string, address: string, credentialId: string, createdAt: string) => ({
  username,
  address,
  credentialId,
  creationDate: new Date(createdAt).getTime(),
  publicKey: '0x00',
});

/** jawegg is the newest, so without the expected account it is the one offered. */
function browserHolds() {
  vi.spyOn(Account, 'getStoredAccounts').mockReturnValue([
    stored('adz', ADZ, 'cred-adz', '2026-01-01'),
    stored('jawegg', JAWEGG, 'cred-jawegg', '2026-02-01'),
  ] as never);
  vi.spyOn(Account, 'getAuthenticatedAddress').mockReturnValue(undefined as never);
}

function tilePasskeyAnswersAs(address: string) {
  vi.spyOn(Account, 'get').mockResolvedValue({ address } as never);
}

/** The passkey picked in "Show more accounts" answers as this account. */
function pickedPasskeyAnswersAs(address: string, username: string) {
  vi.spyOn(Account, 'import').mockResolvedValue({ address, getMetadata: () => ({ username }) } as never);
}

function open(expectedAccount?: string, request: UIRequest = CONNECT) {
  const handler = new ReactUIHandler({ expectedAccount });
  handler.init({ apiKey: 'test-key', defaultChainId: 1 } as never);
  const settled = vi.fn();
  act(() => {
    void handler.request(request).then(settled, settled);
  });
  return settled;
}

const text = () => document.body.textContent ?? '';
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLElement;

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(async () => {
  await act(async () => undefined);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReactUIHandler expectedAccount', () => {
  it('offers the expected account and says the request is for it', async () => {
    browserHolds();
    tilePasskeyAnswersAs(ADZ);
    open(ADZ);

    expect(text()).toContain('This request is for adz (0x0000...00a1).');
    await click('Requested');
    expect(Account.get).toHaveBeenCalledWith(expect.anything(), 'cred-adz');
  });

  it('names both accounts and does not answer when the user ends on another one', async () => {
    browserHolds();
    pickedPasskeyAnswersAs(JAWEGG, 'jawegg');
    const settled = open(ADZ);

    await click('Show more accounts');

    expect(text()).toContain('Signed in as jawegg (0x0000...00b2).');
    expect(text()).toContain('This request is for adz (0x0000...00a1).');
    expect(settled).not.toHaveBeenCalled();
  });

  it('goes back to the sign-in choice with "Use another passkey"', async () => {
    browserHolds();
    pickedPasskeyAnswersAs(JAWEGG, 'jawegg');
    open(ADZ);
    await click('Show more accounts');

    await click('Use another passkey');

    expect(text()).not.toContain('Signed in as');
    expect(text()).toContain('This request is for adz');
  });

  it('declines the request with "Cancel" on the mismatch screen', async () => {
    browserHolds();
    pickedPasskeyAnswersAs(JAWEGG, 'jawegg');
    const settled = open(ADZ);
    await click('Show more accounts');

    await click('Cancel');

    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('answers when the user ends on the expected account', async () => {
    browserHolds();
    tilePasskeyAnswersAs(ADZ);
    const settled = open(ADZ);

    await click('Requested');

    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ approved: true, data: { accounts: [{ address: ADZ }] } })
    );
  });

  it('does not answer silently from a session for another account', async () => {
    browserHolds();
    vi.spyOn(Account, 'getAuthenticatedAddress').mockReturnValue(JAWEGG as never);
    const settled = open(ADZ, SILENT_CONNECT);
    await act(async () => undefined);
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    expect(settled).not.toHaveBeenCalled();
    expect(text()).toContain('This request is for adz');
  });

  it('answers silently from a session for the expected account', async () => {
    browserHolds();
    vi.spyOn(Account, 'getAuthenticatedAddress').mockReturnValue(ADZ as never);
    const settled = open(ADZ, SILENT_CONNECT);
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ approved: true }));
  });

  it('asks nothing extra without an expected account', async () => {
    browserHolds();
    open();

    expect(text()).not.toContain('This request is for');
    expect(text()).toContain('Pick up where you left off.');
  });
});

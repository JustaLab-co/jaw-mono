// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toCoinType } from 'viem';

import { clearAddressIdentityCache } from '../../utils/addressIdentity';
import { OnboardingDialog } from './index';
import type { LocalStorageAccount, OnboardingDialogProps } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LAST_USED = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const NAMES: Record<string, string> = { [LAST_USED]: 'ghadi.justan.id', [OTHER]: 'other.justan.id' };

const accounts: LocalStorageAccount[] = [
  { username: 'ghadi', creationDate: new Date('2026-01-02'), credentialId: 'cred-last', address: LAST_USED },
  { username: 'other', creationDate: new Date('2026-01-01'), credentialId: 'cred-other', address: OTHER },
];

const props: OnboardingDialogProps = {
  accounts,
  onAccountSelect: async () => undefined,
  loggingInAccount: null,
  onImportAccount: () => undefined,
  isImporting: false,
  onCreateAccount: async () => {
    throw new Error('not used');
  },
  onAccountCreationComplete: async () => undefined,
  isCreating: false,
  mainnetRpcUrl: 'https://rpc.test/mainnet',
  lastAuthenticatedCredentialId: 'cred-last',
};

let reverseRequests: URL[];

/**
 * Names answer straight away. A `records=true` request, the only one that carries
 * avatars, answers only when `releaseRecords` is called, as when the records lookup
 * stalls upstream.
 */
let releaseRecords: () => void;

function stubNetwork() {
  reverseRequests = [];
  let release: () => void = () => undefined;
  const recordsGate = new Promise<void>((resolve) => (release = resolve));
  releaseRecords = () => release();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (!url.pathname.startsWith('/ens/v2/reverse')) return new Response('{}', { status: 200 });
      reverseRequests.push(url);
      const withRecords = url.searchParams.get('records') === 'true';
      if (withRecords) await recordsGate;
      const data = url.searchParams.getAll('address').map((param) => {
        const [address, chain] = param.split('@eip155:');
        const name = NAMES[address.toLowerCase()] ?? null;
        return {
          address: address.toLowerCase(),
          name,
          coinType: Number(toCoinType(Number(chain))),
          records: withRecords && name ? { records: { texts: [{ key: 'avatar', value: 'https://x/a.png' }] } } : null,
        };
      });
      return new Response(JSON.stringify({ result: { data } }), { status: 200 });
    })
  );
}

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const avatarImage = () =>
  Array.from(container.querySelectorAll('img')).find((img) => img.src.includes('/avatar/ghadi.justan.id'));

beforeEach(() => {
  clearAddressIdentityCache();
  stubNetwork();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('OnboardingDialog "Continue as" tile', () => {
  it('shows the name while the avatar is still on the way', async () => {
    await act(async () => {
      root.render(createElement(OnboardingDialog, props));
    });
    await settle();

    expect(container.textContent).toContain('ghadi.justan.id');
    expect(avatarImage()).toBeUndefined();
  });

  it('fills in the avatar once it answers', async () => {
    await act(async () => {
      root.render(createElement(OnboardingDialog, props));
    });
    await settle();
    releaseRecords();
    await settle();

    expect(container.textContent).toContain('ghadi.justan.id');
    expect(avatarImage()).toBeDefined();
  });

  it('asks names for every account, and an avatar only for the "Continue as" account', async () => {
    await act(async () => {
      root.render(createElement(OnboardingDialog, props));
    });
    await settle();
    releaseRecords();
    await settle();

    const names = reverseRequests.filter((url) => url.searchParams.get('records') !== 'true');
    const avatars = reverseRequests.filter((url) => url.searchParams.get('records') === 'true');
    expect(names).toHaveLength(1);
    expect(names[0].searchParams.getAll('address').sort()).toEqual([`${LAST_USED}@eip155:1`, `${OTHER}@eip155:1`]);
    expect(avatars).toHaveLength(1);
    expect(avatars[0].searchParams.getAll('address')).toEqual([`${LAST_USED}@eip155:1`]);
  });
});

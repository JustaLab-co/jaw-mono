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

// The "Continue as" account is second, and not the newest, so only the credential match picks it.
const accounts: LocalStorageAccount[] = [
  { username: 'other', creationDate: new Date('2026-01-03'), credentialId: 'cred-other', address: OTHER },
  { username: 'ghadi', creationDate: new Date('2026-01-02'), credentialId: 'cred-last', address: LAST_USED },
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
 * Names answer straight away. A `records=true` request never answers, as when the records
 * lookup stalls upstream, so anything that waits on one never shows.
 */
function stubNetwork() {
  reverseRequests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (!url.pathname.startsWith('/ens/v2/reverse')) return new Response('{}', { status: 200 });
      reverseRequests.push(url);
      if (url.searchParams.get('records') === 'true') return new Promise<Response>(() => undefined);
      const data = url.searchParams.getAll('address').map((param) => {
        const [address, chain] = param.split('@eip155:');
        return {
          address: address.toLowerCase(),
          name: NAMES[address.toLowerCase()] ?? null,
          coinType: Number(toCoinType(Number(chain))),
          records: null,
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

const avatarImages = () => Array.from(container.querySelectorAll('img')).filter((img) => img.src.includes('/avatar/'));

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
  it('shows the name and its avatar from the names request alone', async () => {
    await act(async () => {
      root.render(createElement(OnboardingDialog, props));
    });
    await settle();

    expect(container.textContent).toContain('ghadi.justan.id');
    expect(avatarImages().map((img) => img.src)).toEqual([
      'https://metadata.ens.domains/mainnet/avatar/ghadi.justan.id',
    ]);
  });

  it('asks every account in one request, without records', async () => {
    await act(async () => {
      root.render(createElement(OnboardingDialog, props));
    });
    await settle();

    expect(reverseRequests).toHaveLength(1);
    expect(reverseRequests[0].searchParams.get('records')).toBeNull();
    expect(reverseRequests[0].searchParams.getAll('address').sort()).toEqual([
      `${LAST_USED}@eip155:1`,
      `${OTHER}@eip155:1`,
    ]);
  });
});

describe('OnboardingDialog account list', () => {
  const rows = () => Array.from(container.querySelectorAll('li'));

  it('opens on every stored account, the last used first and marked, and connects the one tapped', async () => {
    const selected: string[] = [];
    await act(async () => {
      root.render(
        createElement(OnboardingDialog, {
          ...props,
          startOnAccountList: true,
          onAccountSelect: async (account) => void selected.push(account.username),
        })
      );
    });
    await settle();

    expect(container.textContent).toContain('Choose an account.');
    expect(container.textContent).not.toContain('Welcome back.');
    expect(rows().map((row) => row.textContent)).toEqual(['Last usedghadi.justan.id', 'other.justan.id']);

    await act(async () => rows()[1].querySelector('button')!.click());
    expect(selected).toEqual(['other']);
  });

  it('with no sign-in recorded, marks no account and lists the newest first', async () => {
    await act(async () => {
      root.render(
        createElement(OnboardingDialog, { ...props, startOnAccountList: true, lastAuthenticatedCredentialId: null })
      );
    });
    await settle();

    expect(rows().map((row) => row.textContent)).toEqual(['other.justan.id', 'ghadi.justan.id']);
  });

  it('leaves out an account with no passkey, and Back from sign in returns to the list', async () => {
    const legacy: LocalStorageAccount = { username: 'legacy', creationDate: new Date('2026-01-04') };
    await act(async () => {
      root.render(
        createElement(OnboardingDialog, { ...props, accounts: [...accounts, legacy], startOnAccountList: true })
      );
    });
    await settle();
    expect(rows()).toHaveLength(2);

    const button = (text: string) =>
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text)!;
    await act(async () => button('Create new account').click());
    expect(container.textContent).toContain('Sign up.');
    await act(async () => button('Back').click());
    expect(container.textContent).toContain('Choose an account.');
  });

  it('without the option, opens on the one-tap last used account', async () => {
    await act(async () => {
      root.render(createElement(OnboardingDialog, props));
    });
    await settle();

    expect(container.textContent).toContain('Welcome back.');
    expect(rows()).toEqual([]);
  });
});

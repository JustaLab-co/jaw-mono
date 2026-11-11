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

describe('OnboardingDialog with an expected account', () => {
  const dialogProps = { ...props, expectedAccount: OTHER };

  it('offers the expected account instead of the last signed-in one', async () => {
    await act(async () => {
      root.render(createElement(OnboardingDialog, dialogProps));
    });
    await settle();

    expect(container.textContent).toContain('other.justan.id');
    expect(container.textContent).toContain('This request is for other.justan.id (0x2222...2222).');
  });

  it('names the expected account by address when it is not stored here', async () => {
    const elsewhere = '0x3333333333333333333333333333333333333333';
    await act(async () => {
      root.render(createElement(OnboardingDialog, { ...props, expectedAccount: elsewhere }));
    });
    await settle();

    expect(container.textContent).toContain('This request is for 0x3333...3333.');
  });

  it('names both accounts and offers another passkey once the user ended on a different one', async () => {
    const onRetryAccount = vi.fn();
    await act(async () => {
      root.render(
        createElement(OnboardingDialog, {
          ...dialogProps,
          mismatchedAccount: { address: LAST_USED },
          onRetryAccount,
        })
      );
    });
    await settle();

    expect(container.textContent).toContain('Signed in as ghadi.justan.id (0x1111...1111).');
    expect(container.textContent).toContain('This request is for other.justan.id (0x2222...2222).');
    const retry = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Use another passkey')
    );
    act(() => retry?.click());
    expect(onRetryAccount).toHaveBeenCalledTimes(1);
  });
});

describe('OnboardingDialog tile label', () => {
  const render = async (extra: Partial<OnboardingDialogProps>) => {
    await act(async () => {
      root.render(createElement(OnboardingDialog, { ...props, ...extra }));
    });
    await settle();
  };

  it('says Requested when the expected account is not the last signed-in one', async () => {
    await render({ expectedAccount: OTHER });

    expect(container.textContent).toContain('Requested');
    expect(container.textContent).not.toContain('Last used');
  });

  it('says Last used when the expected account is the last signed-in one', async () => {
    await render({ expectedAccount: LAST_USED });

    expect(container.textContent).toContain('Last used');
    expect(container.textContent).not.toContain('Requested');
  });

  it('says Last used when no account is expected', async () => {
    await render({});

    expect(container.textContent).toContain('Last used');
    expect(container.textContent).not.toContain('Requested');
  });
});

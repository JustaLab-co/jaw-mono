// @vitest-environment jsdom
// Pins how a revocation resolves its permission. This wiring previously lived twice — in the SDK's
// own handler and in the keys popup — and the copies drifted: one passed the request's address as
// `from`, the other the connected wallet, so the popup reported 'not-granter' and blocked legitimate
// revocations. These tests exist so that class of drift can't return.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Address, Hex } from 'viem';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@jaw.id/core', async () => {
  const actual = await vi.importActual<typeof import('@jaw.id/core')>('@jaw.id/core');
  return {
    ANY_FN_SEL: actual.ANY_FN_SEL,
    ANY_TARGET: actual.ANY_TARGET,
    EMPTY_CALLDATA_FN_SEL: actual.EMPTY_CALLDATA_FN_SEL,
    PERMISSIONS_MANAGER_ADDRESS: actual.PERMISSIONS_MANAGER_ADDRESS,
    classifyPermissionLookupFailure: actual.classifyPermissionLookupFailure,
    getPermissionFromRelay: vi.fn(),
  };
});

import { getPermissionFromRelay } from '@jaw.id/core';
import { usePermissionRevocation, type UsePermissionRevocationResult } from './usePermissionRevocation';

const relayMock = vi.mocked(getPermissionFromRelay);

const PERMISSION_ID = '0xabc1'.padEnd(66, '0') as Hex;
const GRANTER = '0x1111111111111111111111111111111111111111' as Address;
const SPENDER = '0x2222222222222222222222222222222222222222' as Address;
/** A second account the same passkey owns — the case the two copies disagreed about. */
const OTHER_OWNED = '0x4444444444444444444444444444444444444444' as Address;

const relayPermission = {
  account: GRANTER,
  spender: SPENDER,
  start: 0,
  end: 0,
  chainId: '84532',
  spends: [],
  calls: [{ target: '0x3333333333333333333333333333333333333333', selector: '0xa9059cbb' }],
};

let hook: UsePermissionRevocationResult;

function Probe(props: { permissionId?: Hex; apiKey?: string; from?: Address; enabled?: boolean }) {
  hook = usePermissionRevocation({
    permissionId: props.permissionId,
    apiKey: props.apiKey,
    chainId: 84532,
    from: props.from,
    enabled: props.enabled,
  });
  return null;
}

let root: Root | null = null;

async function mount(props: { permissionId?: Hex; apiKey?: string; from?: Address; enabled?: boolean } = {}) {
  const merged = { permissionId: PERMISSION_ID, apiKey: 'key', from: GRANTER, ...props };
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(createElement(Probe, merged));
  });
  // Let the relay promise settle.
  for (let i = 0; i < 10 && hook.loading; i++) await act(() => Promise.resolve());
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.clearAllMocks();
});

describe('usePermissionRevocation', () => {
  it('returns the permission and no problem once the relay answers', async () => {
    relayMock.mockResolvedValue(relayPermission as never);
    await mount();
    expect(hook.loading).toBe(false);
    expect(hook.problem).toBeNull();
    // Returned, not kept private: callers build the revoke call and the spend rows from it, and the
    // fetch must happen only once.
    expect(hook.permission).toMatchObject({ account: GRANTER, spender: SPENDER });
    expect(relayMock).toHaveBeenCalledTimes(1);
  });

  it('reports missing-id when the request carries no permission id', async () => {
    await mount({ permissionId: undefined });
    expect(hook.problem).toBe('missing-id');
    expect(hook.loading).toBe(false);
    // A revocation is *about* a permission, so there is nothing to look up.
    expect(relayMock).not.toHaveBeenCalled();
  });

  // A dApp registered by origin has no key, and the relay resolves it from the
  // origin instead. Refusing here built the revocation from no record at all.
  it('looks the permission up with no api key', async () => {
    await mount({ apiKey: undefined });
    expect(hook.problem).toBeNull();
    expect(relayMock).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it('reports not-found on a relay 404 — the permission is gone', async () => {
    relayMock.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
    await mount();
    expect(hook.problem).toBe('not-found');
    expect(hook.permission).toBeNull();
  });

  it.each([500, 502, 403])('reports lookup-failed on a %s — our lookup, not the permission', async (status) => {
    relayMock.mockRejectedValue(Object.assign(new Error('server'), { status }));
    await mount();
    expect(hook.problem).toBe('lookup-failed');
  });

  it('reports lookup-failed on a status-less transport error', async () => {
    relayMock.mockRejectedValue(new Error('Network Error'));
    await mount();
    expect(hook.problem).toBe('lookup-failed');
  });

  // The regression this hook exists for: `from` is the request's account, never whichever wallet is
  // connected. The keys popup passed the connected wallet and so blocked valid revocations.
  it('accepts the granter as `from`', async () => {
    relayMock.mockResolvedValue(relayPermission as never);
    await mount({ from: GRANTER });
    expect(hook.problem).toBeNull();
  });

  it('reports not-granter when `from` is another account, even one the passkey owns', async () => {
    relayMock.mockResolvedValue(relayPermission as never);
    await mount({ from: OTHER_OWNED });
    expect(hook.problem).toBe('not-granter');
  });

  it('skips the granter check when `from` is unknown', async () => {
    relayMock.mockResolvedValue(relayPermission as never);
    await mount({ from: undefined });
    expect(hook.problem).toBeNull();
  });

  it('does nothing at all on the grant screen', async () => {
    await mount({ enabled: false });
    expect(hook.problem).toBeNull();
    expect(hook.permission).toBeNull();
    expect(hook.loading).toBe(false);
    expect(relayMock).not.toHaveBeenCalled();
  });

  // Derived rather than stored: a `loading` initialised false would report "no problem" for one
  // render, briefly enabling Confirm on a permission nothing is known about yet.
  it('is loading before the relay answers, and reports no problem while it is', async () => {
    let resolve!: (value: unknown) => void;
    relayMock.mockReturnValue(new Promise((r) => (resolve = r)) as never);
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root!.render(createElement(Probe, { permissionId: PERMISSION_ID, apiKey: 'key', from: GRANTER }));
    });
    expect(hook.loading).toBe(true);
    expect(hook.problem).toBeNull();
    await act(async () => {
      resolve(relayPermission);
    });
    expect(hook.loading).toBe(false);
  });
});

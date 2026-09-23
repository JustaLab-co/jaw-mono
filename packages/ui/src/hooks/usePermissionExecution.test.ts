// @vitest-environment jsdom
// Pins how a permissioned execution resolves its permission: only a relay 404 may claim the
// permission is gone (hard-blocking 'revoked'); every other failure — 5xx, network, missing
// key — is our lookup failing and must surface as the non-blocking 'lookup-failed'.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Hex } from 'viem';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@jaw.id/core', async () => {
  const actual = await vi.importActual<typeof import('@jaw.id/core')>('@jaw.id/core');
  return {
    ANY_FN_SEL: actual.ANY_FN_SEL,
    ANY_TARGET: actual.ANY_TARGET,
    EMPTY_CALLDATA_FN_SEL: actual.EMPTY_CALLDATA_FN_SEL,
    PERMISSIONS_MANAGER_ADDRESS: actual.PERMISSIONS_MANAGER_ADDRESS,
    getPermissionFromRelay: vi.fn(),
  };
});

import { getPermissionFromRelay } from '@jaw.id/core';
import { usePermissionExecution, type UsePermissionExecutionResult } from './usePermissionExecution';

const relayMock = vi.mocked(getPermissionFromRelay);

const PERMISSION_ID = '0xabc1'.padEnd(66, '0') as Hex;
const GRANTER = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';

const relayPermission = {
  account: GRANTER,
  spender: SPENDER,
  start: 0,
  end: 0,
  chainId: '84532',
  calls: [{ target: '0x3333333333333333333333333333333333333333', selector: '0xa9059cbb' }],
};

let hook: UsePermissionExecutionResult;

function Probe({ apiKey }: { apiKey?: string }) {
  hook = usePermissionExecution({
    permissionId: PERMISSION_ID,
    apiKey,
    chainId: 84532,
    from: SPENDER,
    calls: [{ to: '0x3333333333333333333333333333333333333333', data: '0xa9059cbb' }],
  });
  return null;
}

let root: Root | null = null;

async function mount(apiKey?: string) {
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(createElement(Probe, { apiKey }));
  });
  // Let the relay promise settle.
  for (let i = 0; i < 10 && hook.loading; i++) await act(() => Promise.resolve());
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.clearAllMocks();
});

describe('usePermissionExecution lookup outcomes', () => {
  it('resolves the granter and reports no problem for a valid permission', async () => {
    relayMock.mockResolvedValue(relayPermission as never);
    await mount('test-key');

    expect(hook.loading).toBe(false);
    expect(hook.onBehalfOf).toBe(GRANTER);
    expect(hook.problem).toBeNull();
  });

  it('a relay 404 means the permission is gone: revoked', async () => {
    // The shape core's controlledAxiosPromise rethrows for a structured error body.
    relayMock.mockRejectedValue(Object.assign(new Error('Permission not found'), { status: 404 }));
    await mount('test-key');

    expect(hook.problem).toBe('revoked');
  });

  it('a raw transport 404 (no structured body) is also revoked', async () => {
    // AxiosError passthrough: status only on response.status.
    relayMock.mockRejectedValue(Object.assign(new Error('Request failed'), { response: { status: 404 } }));
    await mount('test-key');

    expect(hook.problem).toBe('revoked');
  });

  it('a 5xx is a failed lookup, not a revocation', async () => {
    relayMock.mockRejectedValue(Object.assign(new Error('Internal server error'), { status: 500 }));
    await mount('test-key');

    expect(hook.problem).toBe('lookup-failed');
  });

  it('a statusless failure (network drop, CORS) is a failed lookup', async () => {
    relayMock.mockRejectedValue(new Error('Network Error'));
    await mount('test-key');

    expect(hook.problem).toBe('lookup-failed');
  });

  // A dApp registered by origin has no key, and the relay resolves it from the
  // origin instead. Refusing here left the screen unable to say whose funds move.
  it('looks the permission up with no api key', async () => {
    relayMock.mockResolvedValue(relayPermission as never);
    await mount(undefined);

    expect(relayMock).toHaveBeenCalledWith(PERMISSION_ID, undefined);
    expect(hook.problem).toBeNull();
  });
});

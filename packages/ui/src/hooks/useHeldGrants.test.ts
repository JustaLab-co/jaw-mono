// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StorePermissionApiResponse } from '@jaw.id/core';

const getPermissions = vi.fn();
const readContract = vi.fn();

vi.mock('@jaw.id/core', async (importActual) => ({
  ...(await importActual<typeof import('@jaw.id/core')>()),
  handleGetPermissionsRequest: (...args: unknown[]) => getPermissions(...args),
}));
vi.mock('../utils/publicClient', () => ({ getPublicClient: () => ({ readContract }) }));

const { useHeldGrants, liveForSpender, totalsOf } = await import('./useHeldGrants');
type State = ReturnType<typeof useHeldGrants>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const SPENDER = '0x65c8f80520052212f80dfc4b4474a89b5b4bb0c7' as const;
const OTHER = '0x3333333333333333333333333333333333333333' as const;
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as const;
const CHAIN = 84532;
const NOW = 1_800_000_000;

let n = 0;
function row(over: Partial<StorePermissionApiResponse> = {}): StorePermissionApiResponse {
  n += 1;
  return {
    permissionId: `0x${n.toString(16).padStart(64, '0')}`,
    account: ACCOUNT,
    spender: SPENDER,
    start: NOW - 100,
    end: NOW + 86_400,
    salt: '0x01',
    calls: [{ target: USDC, selector: '0xa9059cbb', checker: '0x0000000000000000000000000000000000000000' }],
    spends: [{ token: USDC, allowance: '0xf4240', unit: 'day', multiplier: 1 }],
    chainId: '0x14a34',
    ...over,
  };
}

describe('liveForSpender', () => {
  const live = (rows: StorePermissionApiResponse[]) =>
    liveForSpender(rows, { spender: SPENDER, chainId: CHAIN, now: NOW });

  it('given grants to the spender in any address case, when filtered, then keeps them', () => {
    const upper = row({ spender: '0x65C8F80520052212F80DFC4B4474A89B5B4BB0C7' });
    expect(live([row(), upper])).toHaveLength(2);
  });

  it('given grants to another spender, on another chain, or expired, when filtered, then drops them', () => {
    expect(
      live([row({ spender: OTHER }), row({ chainId: '0x2105' }), row({ end: NOW }), row({ end: NOW - 1 })])
    ).toEqual([]);
  });

  it('given a grant that has not started yet, when filtered, then counts it as held', () => {
    expect(live([row({ start: NOW + 60 })])).toHaveLength(1);
  });

  it('given the index returns the same permission twice, when filtered, then counts it once', () => {
    const once = row();
    expect(live([once, { ...once, permissionId: once.permissionId.toUpperCase().replace('0X', '0x') }])).toHaveLength(
      1
    );
  });
});

describe('totalsOf', () => {
  it('given two daily USDC grants in hex and decimal, when summed, then reports one total and two grants', () => {
    const held = totalsOf([
      row(),
      row({
        spends: [{ token: USDC.toUpperCase().replace('0X', '0x'), allowance: '500000', unit: 'day', multiplier: 1 }],
      }),
    ]);
    expect(held.count).toBe(2);
    expect(held.totals).toEqual([{ token: USDC, unit: 'day', multiplier: 1, allowance: 1_500_000n }]);
  });

  it('given the same token over different periods, when summed, then keeps them apart', () => {
    const held = totalsOf([row(), row({ spends: [{ token: USDC, allowance: '7', unit: 'week', multiplier: 1 }] })]);
    expect(held.totals.map((t) => [t.unit, t.allowance])).toEqual([
      ['day', 1_000_000n],
      ['week', 7n],
    ]);
  });

  it('given a calls-only grant, when summed, then counts it with no total', () => {
    expect(totalsOf([row({ spends: [] })])).toEqual({ count: 1, totals: [] });
  });
});

describe('useHeldGrants', () => {
  let root: Root | null = null;
  let state: State | null = null;

  function Probe() {
    state = useHeldGrants({ address: ACCOUNT, spender: SPENDER, chainId: CHAIN, apiKey: 'k', rpcUrl: 'https://rpc' });
    return null;
  }

  async function render() {
    const mounted = createRoot(document.createElement('div'));
    root = mounted;
    await act(async () => mounted.render(createElement(Probe)));
    await act(async () => undefined);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW * 1000);
    readContract.mockResolvedValue(false);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    state = null;
    vi.useRealTimers();
    getPermissions.mockReset();
    readContract.mockReset();
  });

  it('given live grants to the spender, when the screen opens, then reports their total for this account and chain', async () => {
    getPermissions.mockResolvedValue([row(), row(), row({ spender: OTHER })]);
    await render();

    expect(getPermissions).toHaveBeenCalledWith(
      { method: 'wallet_getPermissions', params: [{ address: ACCOUNT, chainId: '0x14a34' }] },
      'k'
    );
    expect(state).toEqual({
      status: 'ready',
      held: { count: 2, totals: [{ token: USDC, unit: 'day', multiplier: 1, allowance: 2_000_000n }] },
    });
  });

  it('given the chain reports one grant revoked, when the screen opens, then leaves it out', async () => {
    const revoked = row({ salt: '0x0bad' });
    getPermissions.mockResolvedValue([row(), revoked]);
    readContract.mockImplementation(async ({ args: [p] }) => p.salt === 0xbadn);
    await render();

    expect(state).toMatchObject({ status: 'ready', held: { count: 1 } });
  });

  it('given a yearly grant, when checked on chain, then the struct carries twelve months', async () => {
    getPermissions.mockResolvedValue([row({ spends: [{ token: USDC, allowance: '1', unit: 'year', multiplier: 2 }] })]);
    await render();

    expect(readContract.mock.calls[0][0].args[0].spends[0]).toMatchObject({ unit: 4, multiplier: 24 });
  });

  it('given the chain read fails, when the screen opens, then keeps the grant rather than understate', async () => {
    getPermissions.mockResolvedValue([row()]);
    readContract.mockRejectedValue(new Error('node down'));
    await render();

    expect(state).toMatchObject({ status: 'ready', held: { count: 1 } });
  });

  it('given the index lookup fails, when the screen opens, then reports unknown, not zero', async () => {
    getPermissions.mockRejectedValue(new Error('500'));
    await render();

    expect(state).toEqual({ status: 'unknown' });
  });

  it('given the index never answers, when the timeout passes, then reports unknown', async () => {
    getPermissions.mockReturnValue(new Promise(() => undefined));
    await render();
    expect(state).toEqual({ status: 'loading' });

    await act(async () => vi.advanceTimersByTime(8_000));
    expect(state).toEqual({ status: 'unknown' });
  });
});

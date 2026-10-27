// @vitest-environment jsdom
// Which calls of a request get the amber allowance flag. `approve(address,uint256)` is the same call
// on an ERC-20 and an ERC-721, and an ERC-721 id can fill the whole uint256 range, so a large
// `approve` is read before it is flagged.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelhash, maxUint160, maxUint256 } from 'viem';

const readContract = vi.fn();
const clientChains: number[] = [];
vi.mock('../utils/publicClient', () => ({
  getJawPublicClient: (chainId: number) => {
    clientChains.push(chainId);
    return { readContract };
  },
}));

import { useAllowanceFlags, type AllowanceFlag } from './useAllowanceFlags';
import { APPROVAL_TOKEN_READ_TIMEOUT_MS } from './useApprovalTokenKind';
import type { AssetDelta } from '../utils/assetPreview';

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const BASE_REGISTRAR = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const OWNER = '0x2222222222222222222222222222222222222222';
const SPENDER = '0x1111111111111111111111111111111111111111';
// The ENS token id of vitalik.eth: its labelhash, which is above 2^255.
const VITALIK_ID = BigInt(labelhash('vitalik'));

const word = (hex: string) => hex.padStart(64, '0');
const addr = (a: string) => word(a.slice(2).toLowerCase());
const uint = (n: bigint) => word(n.toString(16));
const sig = `${uint(27n)}${uint(1n)}${uint(2n)}`;

// Selectors from the standard signatures.
const approve = (amount: bigint) => `0x095ea7b3${addr(SPENDER)}${uint(amount)}`;
const increaseAllowance = (amount: bigint) => `0x39509351${addr(SPENDER)}${uint(amount)}`;
const increaseApproval = (amount: bigint) => `0xd73dd623${addr(SPENDER)}${uint(amount)}`;
const approveAndCall = (amount: bigint) => `0x3177029f${addr(SPENDER)}${uint(amount)}`;
const approveAndCallData = (amount: bigint) =>
  `0xcae9ca51${addr(SPENDER)}${uint(amount)}${uint(96n)}${uint(2n)}${'abcd'.padEnd(64, '0')}`;
const setAll = (approved: bigint) => `0xa22cb465${addr(SPENDER)}${uint(approved)}`;
const permit = (value: bigint) => `0xd505accf${addr(OWNER)}${addr(SPENDER)}${uint(value)}${uint(1_900_000_000n)}${sig}`;
const daiPermit = (allowed: bigint) =>
  `0x8fcbaf0c${addr(OWNER)}${addr(SPENDER)}${uint(3n)}${uint(1_900_000_000n)}${uint(allowed)}${sig}`;
const permit2 = (amount: bigint) => `0x87517c45${addr(TOKEN)}${addr(SPENDER)}${uint(amount)}${uint(1_900_000_000n)}`;

const known = (address: string, decimals: number): AssetDelta => ({
  address: address.toLowerCase(),
  symbol: 'TKN',
  decimals,
  diff: -1n,
  direction: 'out',
  amountFormatted: '1',
  isNative: false,
});

/** supportsInterface(0x80ac58cd) answers per token; an Error is a failed read. */
function answer(byToken: Record<string, boolean | Error>) {
  readContract.mockImplementation(async ({ address }: { address: string }) => {
    const value = byToken[address.toLowerCase()];
    if (value instanceof Error) throw value;
    return value;
  });
}

interface Call {
  to: string;
  data: string;
}

let flags: (AllowanceFlag | null)[] = [];
function Probe({ calls, knownTokens, chainId }: { calls: Call[]; knownTokens: AssetDelta[]; chainId?: number }) {
  flags = useAllowanceFlags(calls, knownTokens, chainId, 'k');
  return null;
}

let host: HTMLDivElement;
let root: Root;
function show(calls: Call[], knownTokens: AssetDelta[] = [], chainId: number | null = 1) {
  root.render(createElement(Probe, { calls, knownTokens, chainId: chainId ?? undefined }));
}
const settle = () => act(async () => undefined);
const unlimited = (argIndex: number, amount: bigint): AllowanceFlag => ({ label: 'Unlimited', argIndex, amount });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  readContract.mockReset();
  clientChains.length = 0;
  answer({});
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useAllowanceFlags', () => {
  it('flags each unlimited allowance kind on the argument that carries the amount', async () => {
    const cases: [Call, AllowanceFlag][] = [
      [{ to: TOKEN, data: approve(maxUint256) }, unlimited(1, maxUint256)],
      [{ to: TOKEN, data: increaseAllowance(maxUint256) }, unlimited(1, maxUint256)],
      [{ to: TOKEN, data: increaseApproval(1n << 200n) }, unlimited(1, 1n << 200n)],
      [{ to: TOKEN, data: approveAndCall(maxUint256) }, unlimited(1, maxUint256)],
      [{ to: TOKEN, data: approveAndCallData(maxUint256) }, unlimited(1, maxUint256)],
      [
        { to: TOKEN, data: setAll(1n) },
        { label: 'All tokens', argIndex: 1 },
      ],
      [{ to: TOKEN, data: permit(maxUint256) }, unlimited(2, maxUint256)],
      [{ to: TOKEN, data: daiPermit(1n) }, unlimited(4, maxUint256)],
      [{ to: PERMIT2, data: permit2(maxUint160) }, unlimited(2, maxUint160)],
    ];
    act(() => show(cases.map(([call]) => call)));
    await settle();
    expect(flags).toEqual(cases.map(([, flag]) => flag));
    expect(readContract).not.toHaveBeenCalled();
  });

  it('flags nothing for finite amounts, revokes and calls that grant no allowance', async () => {
    act(() =>
      show([
        { to: TOKEN, data: approve(5_000_000n) },
        { to: TOKEN, data: approve(0n) },
        { to: TOKEN, data: increaseAllowance(maxUint160 - 1n) },
        { to: TOKEN, data: setAll(0n) },
        { to: TOKEN, data: permit(1_000n) },
        { to: TOKEN, data: daiPermit(0n) },
        { to: PERMIT2, data: permit2(maxUint160 - 1n) },
        { to: TOKEN, data: '0x' },
        { to: SPENDER, data: '0xdeadbeef' },
      ])
    );
    await settle();
    expect(flags).toEqual([null, null, null, null, null, null, null, null, null]);
  });

  it('the ENS id used here is in the range that needs a read', () => {
    expect(VITALIK_ID >= 1n << 255n && VITALIK_ID < maxUint256).toBe(true);
  });

  it('never flags an ENS name approval, before or after the read', async () => {
    answer({ [BASE_REGISTRAR.toLowerCase()]: true });
    act(() => show([{ to: BASE_REGISTRAR, data: approve(VITALIK_ID) }]));
    expect(flags).toEqual([null]);
    await settle();
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: BASE_REGISTRAR.toLowerCase(),
        functionName: 'supportsInterface',
        args: ['0x80ac58cd'],
      })
    );
    expect(flags).toEqual([null]);
  });

  it('flags the same amount on a token that is not an ERC-721 once the read settles', async () => {
    answer({ [TOKEN.toLowerCase()]: false });
    act(() => show([{ to: TOKEN, data: approve(VITALIK_ID) }]));
    expect(flags).toEqual([null]);
    await settle();
    expect(flags).toEqual([unlimited(1, VITALIK_ID)]);
  });

  it('flags the same amount when the read fails', async () => {
    answer({ [TOKEN.toLowerCase()]: new Error('rpc down') });
    act(() => show([{ to: TOKEN, data: approve(VITALIK_ID) }]));
    await settle();
    expect(flags).toEqual([unlimited(1, VITALIK_ID)]);
  });

  it('flags the same amount when the read never answers, after the timeout', async () => {
    vi.useFakeTimers();
    readContract.mockImplementation(() => new Promise(() => undefined));
    act(() => show([{ to: TOKEN, data: approve(VITALIK_ID) }]));
    expect(flags).toEqual([null]);
    await act(async () => vi.advanceTimersByTimeAsync(APPROVAL_TOKEN_READ_TIMEOUT_MS));
    expect(flags).toEqual([unlimited(1, VITALIK_ID)]);
  });

  it('flags 2^255 on a token the simulation moved with decimals, without reading it', async () => {
    act(() => show([{ to: TOKEN, data: approve(1n << 255n) }], [known(TOKEN, 6)]));
    expect(flags).toEqual([unlimited(1, 1n << 255n)]);
    await settle();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('still reads a token the simulation moved with 0 decimals, which is how an NFT shows there', async () => {
    answer({ [BASE_REGISTRAR.toLowerCase()]: true });
    act(() => show([{ to: BASE_REGISTRAR, data: approve(VITALIK_ID) }], [known(BASE_REGISTRAR, 0)]));
    await settle();
    expect(readContract).toHaveBeenCalledOnce();
    expect(flags).toEqual([null]);
  });

  it('leaves the other calls of a batch flagged when one is an ERC-721 approve', async () => {
    answer({ [BASE_REGISTRAR.toLowerCase()]: true });
    act(() =>
      show([
        { to: BASE_REGISTRAR, data: approve(VITALIK_ID) },
        { to: SPENDER, data: '0x' },
        { to: TOKEN, data: approve(maxUint256) },
      ])
    );
    await settle();
    expect(flags).toEqual([null, null, unlimited(1, maxUint256)]);
  });

  it('reads each token once in a single pass', async () => {
    const other = '0x3333333333333333333333333333333333333333';
    answer({ [TOKEN.toLowerCase()]: false, [other]: false });
    act(() =>
      show([
        { to: TOKEN, data: approve(VITALIK_ID) },
        { to: TOKEN, data: approve(VITALIK_ID + 1n) },
        { to: other, data: approve(VITALIK_ID) },
      ])
    );
    await settle();
    expect(readContract).toHaveBeenCalledTimes(2);
    expect(flags).toEqual([unlimited(1, VITALIK_ID), unlimited(1, VITALIK_ID + 1n), unlimited(1, VITALIK_ID)]);
  });

  it('reads the token on the chain of the request', async () => {
    answer({ [TOKEN.toLowerCase()]: false });
    act(() => show([{ to: TOKEN, data: approve(VITALIK_ID) }], [], 8453));
    await settle();
    expect(clientChains).toEqual([8453]);
  });

  it('reads the token before flagging an approve of exactly max uint160, which could be an NFT id', async () => {
    answer({ [BASE_REGISTRAR.toLowerCase()]: true, [TOKEN.toLowerCase()]: false });
    act(() =>
      show([
        { to: BASE_REGISTRAR, data: approve(maxUint160) },
        { to: TOKEN, data: approve(maxUint160) },
      ])
    );
    await settle();
    expect(readContract).toHaveBeenCalledTimes(2);
    expect(flags).toEqual([null, unlimited(1, maxUint160)]);
  });

  it('flags a large approve without a chain to read on', async () => {
    act(() => show([{ to: TOKEN, data: approve(VITALIK_ID) }], [], null));
    expect(flags).toEqual([unlimited(1, VITALIK_ID)]);
    await settle();
    expect(readContract).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
// `approve(address,uint256)` is the same call on an ERC-20 and an ERC-721, and an ERC-721 id can
// fill the whole uint256 range, so a large `approve` is read before it reaches the card.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelhash, maxUint256 } from 'viem';

const readContract = vi.fn();
vi.mock('../../utils/publicClient', () => ({
  getJawPublicClient: () => ({ readContract }),
}));

import { AllowancePreview } from './AllowancePreview';
import { APPROVAL_TOKEN_READ_TIMEOUT_MS } from '../../hooks/useApprovalTokenKind';
import type { AllowanceChange } from '../../utils/allowances';
import type { AssetDelta } from '../../utils/assetPreview';

const BASE_REGISTRAR = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SPENDER = '0x1111111111111111111111111111111111111111';
// The ENS token id of vitalik.eth: its labelhash, which is above 2^255.
const VITALIK_ID = BigInt(labelhash('vitalik'));

const approve = (token: string, amount: bigint): AllowanceChange => ({
  token,
  spender: SPENDER,
  amount,
  added: false,
  allTokens: false,
  unlimited: true,
  revoke: false,
  ambiguous: true,
});

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

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function show(changes: AllowanceChange[], knownTokens: AssetDelta[] = [], chainId: number | null = 1) {
  root.render(
    <AllowancePreview changes={changes} knownTokens={knownTokens} chainId={chainId ?? undefined} apiKey="k" />
  );
}
const settle = () => act(async () => undefined);
const card = () => host.textContent?.includes('Token approvals') ?? false;
const rows = () => host.querySelectorAll('[aria-label="Copy spender address"]').length;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  readContract.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('AllowancePreview token reads', () => {
  it('the ENS id used here is in the range the unlimited filter lets through', () => {
    expect(VITALIK_ID >= 1n << 255n).toBe(true);
  });

  it('shows an approve of exactly max uint256 without reading the token', async () => {
    answer({});
    act(() => show([approve(TOKEN, maxUint256)]));
    expect(card()).toBe(true);
    await settle();
    expect(readContract).not.toHaveBeenCalled();
    expect(card()).toBe(true);
  });

  it('never shows an ENS name approval, before or after the read', async () => {
    answer({ [BASE_REGISTRAR.toLowerCase()]: true });
    act(() => show([approve(BASE_REGISTRAR, VITALIK_ID)]));
    expect(card()).toBe(false);
    await settle();
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: BASE_REGISTRAR.toLowerCase(),
        functionName: 'supportsInterface',
        args: ['0x80ac58cd'],
      })
    );
    expect(card()).toBe(false);
  });

  it('shows the same amount on a token that is not an ERC-721 once the read settles', async () => {
    answer({ [TOKEN.toLowerCase()]: false });
    act(() => show([approve(TOKEN, VITALIK_ID)]));
    expect(card()).toBe(false);
    await settle();
    expect(card()).toBe(true);
  });

  it('shows the same amount when the read fails', async () => {
    answer({ [TOKEN.toLowerCase()]: new Error('rpc down') });
    act(() => show([approve(TOKEN, VITALIK_ID)]));
    await settle();
    expect(card()).toBe(true);
  });

  it('shows the same amount when the read never answers, after the timeout', async () => {
    vi.useFakeTimers();
    readContract.mockImplementation(() => new Promise(() => undefined));
    act(() => show([approve(TOKEN, VITALIK_ID)]));
    expect(card()).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(APPROVAL_TOKEN_READ_TIMEOUT_MS));
    expect(card()).toBe(true);
  });

  it('shows 2^255 on a token the simulation moved with decimals, without reading it', async () => {
    answer({});
    act(() => show([approve(TOKEN, 1n << 255n)], [known(TOKEN, 6)]));
    expect(card()).toBe(true);
    await settle();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('still reads a token the simulation moved with 0 decimals, which is how an NFT shows there', async () => {
    answer({ [BASE_REGISTRAR.toLowerCase()]: true });
    act(() => show([approve(BASE_REGISTRAR, VITALIK_ID)], [known(BASE_REGISTRAR, 0)]));
    await settle();
    expect(readContract).toHaveBeenCalledOnce();
    expect(card()).toBe(false);
  });

  it('drops only the ERC-721 row when the card has others', async () => {
    answer({ [BASE_REGISTRAR.toLowerCase()]: true });
    act(() => show([approve(BASE_REGISTRAR, VITALIK_ID), approve(TOKEN, maxUint256)]));
    expect(rows()).toBe(1);
    await settle();
    expect(rows()).toBe(1);
    expect(host.textContent).toContain('Unlimited');
  });

  it('reads each token once in a single pass', async () => {
    const other = '0x3333333333333333333333333333333333333333';
    answer({ [TOKEN.toLowerCase()]: false, [other]: false });
    act(() => show([approve(TOKEN, VITALIK_ID), approve(TOKEN, VITALIK_ID + 1n), approve(other, VITALIK_ID)]));
    await settle();
    expect(readContract).toHaveBeenCalledTimes(2);
    expect(rows()).toBe(3);
  });

  it('shows a large approve without a chain to read on', async () => {
    answer({});
    act(() => show([approve(TOKEN, VITALIK_ID)], [], null));
    expect(card()).toBe(true);
    await settle();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('shows setApprovalForAll as all tokens, without a read', async () => {
    answer({});
    act(() => show([{ ...approve(TOKEN, 0n), amount: undefined, allTokens: true, ambiguous: false }]));
    expect(host.textContent).toContain('All tokens');
    await settle();
    expect(readContract).not.toHaveBeenCalled();
  });
});

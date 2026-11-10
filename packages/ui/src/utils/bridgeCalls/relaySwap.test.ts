import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address } from 'viem';
import { readBridgeBatch } from './batch';
import { BRIDGE_CHAINS } from './contracts';
import {
  RELAY_BRIDGE_SWAP,
  RELAY_BRIDGE_SWAP_APPROVE,
  RELAY_SWAP,
  RELAY_SWAP_ACCOUNT,
  RELAY_SWAP_APPROVE,
  RELAY_USDC_DEPOSIT,
  RELAY_USDC_ORDER,
} from './fixtures';
import { BridgeContracts } from './table';
import type { BridgeCall } from './view';

const contracts = new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS });
const account = RELAY_SWAP_ACCOUNT as Address;

const PROXY = '0x5567954cD026CEbFE486062cb75848e0f1c12E58';
const OLD_PROXY = '0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const OTHER = '0x1111111111111111111111111111111111111111';
const SOLVER = '0xf70da97812CB96acDF810712Aa562db8dfA3dbEF';

const OTHER_CONTRACT = 'This approval is for a different contract than the deposit.';
const OTHER_TOKEN = 'This approval is for a different token than the deposit.';
const CHECK = 'Check it before you confirm.';
const OUTSIDE = `Step 2 calls ${PROXY} outside the bridge. ${CHECK}`;

// The signature Relay's RelayApprovalProxy publishes for selector 0xf9e4bab4.
const PROXY_ABI = parseAbi([
  'function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata)',
]);
const REQUEST_ID = RELAY_SWAP.data!.slice(-64);
const quoted = decodeFunctionData({ abi: PROXY_ABI, data: RELAY_SWAP.data as `0x${string}` }).args;

type Change = Partial<{ tokens: Address[]; amounts: bigint[]; refundTo: Address; nftRecipient: Address }>;
function swapWith(change: Change): BridgeCall {
  const [tokens, amounts, calls, refundTo, nftRecipient, metadata] = quoted;
  const args = [
    change.tokens ?? tokens,
    change.amounts ?? amounts,
    calls,
    change.refundTo ?? refundTo,
    change.nftRecipient ?? nftRecipient,
    metadata,
  ] as const;
  return { ...RELAY_SWAP, data: encodeFunctionData({ abi: PROXY_ABI, args }) + REQUEST_ID };
}

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const approve = (spender: string, amount: bigint): BridgeCall => ({
  ...RELAY_SWAP_APPROVE,
  data: '0x095ea7b3' + word(spender) + word(amount.toString(16)),
});

const tenUsdc = {
  chainId: 8453,
  amount: 10_000_000n,
  token: { address: BASE_USDC, known: true, symbol: 'USDC', decimals: 6 },
};

// A proxy call this screen does not read stays a plain call, as it was before the proxy was pinned.
function expectNotRead(calls: BridgeCall[]) {
  const batch = readBridgeBatch(contracts, calls, account);
  expect(batch?.transfer).toBeUndefined();
  expect(batch?.steps).toEqual([null, null]);
  expect(batch?.alerts).toEqual([]);
  expect(batch?.notices).toContain(OUTSIDE);
}

describe('given the Relay quote for a same-chain swap on Base, 10 USDC to ETH', () => {
  it('when it is read, then it is a Relay swap that sends exactly 10 USDC and lists no terms', () => {
    const batch = readBridgeBatch(contracts, [RELAY_SWAP_APPROVE, RELAY_SWAP], account);
    expect(batch?.transfer).toEqual({
      provider: 'relay',
      title: 'Swap through Relay',
      send: tenUsdc,
      origin: { name: 'Base', nativeSymbol: 'ETH' },
      sameChain: true,
      details: [],
    });
    expect(batch?.steps).toEqual([null, null]);
    expect(batch?.alerts).toEqual([]);
  });

  it('when it is read, then nothing claims what arrives, and no notice repeats the simulated note', () => {
    const batch = readBridgeBatch(contracts, [RELAY_SWAP_APPROVE, RELAY_SWAP], account);
    expect(batch?.transfer?.receive).toBeUndefined();
    expect(batch?.transfer?.destination).toBeUndefined();
    expect(batch?.notices).toEqual([]);
  });

  it('when a Relay order rides along with it, then the order is not used for the swap', () => {
    const batch = readBridgeBatch(contracts, [RELAY_SWAP_APPROVE, RELAY_SWAP], account, {
      orderData: RELAY_USDC_ORDER,
    });
    expect(batch?.transfer?.receive).toBeUndefined();
    expect(batch?.notices).toEqual([]);
  });

  it('when the previous proxy version is the target and the spender, then it reads the same', () => {
    const batch = readBridgeBatch(
      contracts,
      [approve(OLD_PROXY, 10_000_000n), { ...RELAY_SWAP, to: OLD_PROXY }],
      account
    );
    expect(batch?.transfer).toMatchObject({ title: 'Swap through Relay', send: tenUsdc });
    expect(batch?.notices).toEqual([]);
  });

  it('when no approve comes before it, then it is a Relay swap that sends exactly 10 USDC', () => {
    const batch = readBridgeBatch(contracts, [RELAY_SWAP], account);
    expect(batch?.transfer).toMatchObject({ provider: 'relay', title: 'Swap through Relay', send: tenUsdc });
    expect(batch?.steps).toEqual([null]);
    expect(batch?.alerts).toEqual([]);
    expect(batch?.notices).toEqual([]);
  });
});

describe('given a call to the Relay approval proxy in a shape this screen does not read', () => {
  it('when leftovers refund to another address, then it stays a plain call', () => {
    expectNotRead([RELAY_SWAP_APPROVE, swapWith({ refundTo: OTHER })]);
  });

  it('when mints go to another address, then it stays a plain call', () => {
    expectNotRead([RELAY_SWAP_APPROVE, swapWith({ nftRecipient: OTHER })]);
  });

  it('when both go to a pinned solver, as on a same-chain swap, then it is not read as a bridge', () => {
    expectNotRead([RELAY_SWAP_APPROVE, swapWith({ refundTo: SOLVER, nftRecipient: SOLVER })]);
  });

  it('when the swap pulls a second token, then it stays a plain call', () => {
    expectNotRead([RELAY_SWAP_APPROVE, swapWith({ tokens: [BASE_USDC, BASE_WETH], amounts: [10_000_000n, 1n] })]);
  });

  it('when the call carries a value, then it stays a plain call', () => {
    expectNotRead([RELAY_SWAP_APPROVE, { ...RELAY_SWAP, value: '1' }]);
  });

  it('when the calldata stops short, then it stays a plain call', () => {
    expectNotRead([RELAY_SWAP_APPROVE, { ...RELAY_SWAP, data: RELAY_SWAP.data!.slice(0, 600) }]);
  });

  it('when it is the only call, then the batch is not a bridge batch', () => {
    expect(readBridgeBatch(contracts, [{ ...RELAY_SWAP, value: '1' }], account)).toBeNull();
  });
});

describe('given a same-chain Relay swap and an approve before it that does not match', () => {
  const read = (calls: BridgeCall[]) => readBridgeBatch(contracts, calls, account);

  it('when the approve is for another amount, then the swap shows exactly what it pulls', () => {
    const batch = read([RELAY_SWAP_APPROVE, swapWith({ amounts: [9_999_999n] })]);
    expect(batch?.transfer?.send.amount).toBe(9_999_999n);
    expect(batch?.alerts).toEqual([]);
  });

  it('when the approve is for another token, then the approval is named as for a different token', () => {
    const batch = read([RELAY_SWAP_APPROVE, swapWith({ tokens: [BASE_WETH] })]);
    expect(batch?.alerts).toEqual([]);
    expect(batch?.notices).toContain(OTHER_TOKEN);
  });

  it('when the approve goes to the other proxy version, then it is named as for a different contract', () => {
    const batch = read([approve(OLD_PROXY, 10_000_000n), RELAY_SWAP]);
    expect(batch?.alerts).toEqual([]);
    expect(batch?.notices).toEqual([OTHER_CONTRACT]);
  });

  it('when the approve goes to the depository, then it is named as for a different contract', () => {
    const depository = BRIDGE_CHAINS[8453].relay!.depository;
    const batch = read([approve(depository, 10_000_000n), RELAY_SWAP]);
    expect(batch?.alerts).toEqual([]);
    expect(batch?.notices).toEqual([OTHER_CONTRACT]);
  });

  it('when the approve runs on another chain, then nothing pairs with it and no notice shows', () => {
    const batch = read([{ ...RELAY_SWAP_APPROVE, chainId: 10 }, RELAY_SWAP]);
    expect(batch?.transfer).toMatchObject({ title: 'Swap through Relay', send: tenUsdc });
    expect(batch?.notices).toEqual([]);
  });
});

describe('given a transferAndMulticall to an address that is not a pinned proxy of its chain', () => {
  it('when the target and the spender are another address, then the batch is not a bridge batch', () => {
    const batch = readBridgeBatch(contracts, [approve(OTHER, 10_000_000n), { ...RELAY_SWAP, to: OTHER }], account);
    expect(batch).toBeNull();
  });

  it('when only the target is another address, then the call is named as outside the bridge and nothing is summed up', () => {
    const batch = readBridgeBatch(contracts, [RELAY_SWAP_APPROVE, { ...RELAY_SWAP, to: OTHER }], account);
    expect(batch?.transfer).toBeUndefined();
    expect(batch?.notices).toEqual([`Step 2 calls ${OTHER} outside the bridge. ${CHECK}`]);
  });

  it('when the whole batch runs on Linea, whose proxy is another address, then it is not a bridge batch', () => {
    const onLinea = (call: BridgeCall) => ({ ...call, chainId: 59144 });
    expect(readBridgeBatch(contracts, [onLinea(RELAY_SWAP_APPROVE), onLinea(RELAY_SWAP)], account)).toBeNull();
  });

  it('when the whole batch runs on a chain the table lacks, then it is not a bridge batch', () => {
    const elsewhere = (call: BridgeCall) => ({ ...call, chainId: 7777777 });
    expect(readBridgeBatch(contracts, [elsewhere(RELAY_SWAP_APPROVE), elsewhere(RELAY_SWAP)], account)).toBeNull();
  });
});

describe('given an approve to the Relay approval proxy', () => {
  it('when nothing uses it, then it reads as a bridge batch with no summary and no alert', () => {
    const batch = readBridgeBatch(contracts, [RELAY_SWAP_APPROVE], account);
    expect(batch?.transfer).toBeUndefined();
    expect(batch?.alerts).toEqual([]);
  });

  it('when a Relay depository deposit follows it, then the approval is named as for a different contract', () => {
    const batch = readBridgeBatch(contracts, [RELAY_SWAP_APPROVE, RELAY_USDC_DEPOSIT], account);
    expect(batch?.notices).toContain('This approval is for a different contract than the deposit.');
  });
});

describe('given the Relay quote for a cross-chain swap, 100 AERO on Base to ETH on Arbitrum', () => {
  it('when it is read, then nothing on the other chain is claimed and the proxy call stays a plain call', () => {
    const batch = readBridgeBatch(contracts, [RELAY_BRIDGE_SWAP_APPROVE, RELAY_BRIDGE_SWAP], account);
    expect(batch?.transfer).toBeUndefined();
    expect(batch?.alerts).toEqual([]);
    expect(batch?.notices).toContain(OUTSIDE);
  });
});

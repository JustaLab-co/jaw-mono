import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, zeroAddress } from 'viem';
import { readAcrossStore } from './across';
import { readBridgeBatch } from './batch';
import { SIGNER } from './fixtures';
import { snapshotContracts } from './table';
import type { BridgeCall } from './view';

const contracts = snapshotContracts();

const STORE = '0x794dBdbDBFd3f8A3b887F4513bf5FF29edD04a94';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ORDER_ID = '0x1732e19275968d23d44fc2e93f2b92ad6322a61fa1143fea32407016886a299c';
const UNREADABLE = { kind: 'unreadable', what: 'deposit' };
const ACROSS_HIDDEN =
  'Across keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';

// Live Across API v1 quotes, USDC and ETH from Base to Arbitrum.
const USDC_STORE: BridgeCall = {
  chainId: 8453,
  to: STORE.toLowerCase(),
  value: '0',
  data: '0x1e04ce081732e19275968d23d44fc2e93f2b92ad6322a61fa1143fea32407016886a299c000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000004c4b40',
};
const ETH_STORE: BridgeCall = {
  chainId: 8453,
  to: STORE.toLowerCase(),
  value: '3000000000000000',
  data: '0x1e04ce08e4076372fc03b5ce5980db34d06c6c9f8c375755ddf02427a59e6274dab0e94e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
};
const APPROVE: BridgeCall = {
  chainId: 8453,
  to: BASE_USDC,
  value: '0',
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [STORE, 5_000_000n] }),
};

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
function withArg(call: BridgeCall, index: number, hex: string): BridgeCall {
  const data = call.data ?? '';
  const start = 10 + index * 64;
  return { ...call, data: data.slice(0, start) + word(hex) + data.slice(start + 64) };
}

describe('given an Across v1 store on the pinned Base prefunded store', () => {
  it('when the USDC quote is read, then it is an order for 5 USDC on Base', () => {
    expect(readAcrossStore(contracts, USDC_STORE)).toEqual({
      kind: 'order',
      provider: 'across',
      send: {
        chainId: 8453,
        amount: 5_000_000n,
        token: { address: BASE_USDC, known: true, symbol: 'USDC', decimals: 6 },
      },
      orderId: ORDER_ID,
    });
  });

  it('when the ETH quote is read, then the value is what it sends', () => {
    expect(readAcrossStore(contracts, ETH_STORE)).toMatchObject({
      kind: 'order',
      send: { amount: 3_000_000_000_000_000n, token: { address: zeroAddress, symbol: 'ETH' } },
    });
  });

  it('when the call goes to another address or chain, then it is not read', () => {
    expect(readAcrossStore(contracts, { ...USDC_STORE, to: BASE_USDC })).toBeUndefined();
    expect(readAcrossStore(contracts, { ...USDC_STORE, chainId: 84532 })).toBeUndefined();
  });

  it.each([
    ['an ERC-20 store carries value', { ...USDC_STORE, value: '1' }],
    ['an ERC-20 store has amount 0', withArg(USDC_STORE, 2, '0x0')],
    ['a native store has an amount', withArg(ETH_STORE, 2, '0x1')],
    ['a native store carries no value', { ...ETH_STORE, value: '0' }],
    ['bytes follow the arguments', { ...USDC_STORE, data: `${USDC_STORE.data}00` }],
    ['the selector is another one', { ...USDC_STORE, data: `0x12345678${USDC_STORE.data?.slice(10)}` }],
  ])('when %s, then it is unreadable', (_, call) => {
    expect(readAcrossStore(contracts, call)).toEqual(UNREADABLE);
  });
});

describe('given the Across v1 batch, approve to the prefunded store then store', () => {
  it('when it is read, then the screen shows a deposit to Across with the order and the hidden terms notice', () => {
    expect(readBridgeBatch(contracts, [APPROVE, USDC_STORE], SIGNER)).toEqual({
      transfer: {
        provider: 'across',
        title: 'Deposit to Across',
        send: expect.objectContaining({ amount: 5_000_000n }),
        origin: { name: 'Base', nativeSymbol: 'ETH' },
        details: [{ label: 'Order', value: '0x1732…299c', copy: ORDER_ID }],
      },
      steps: [null, null],
      alerts: [],
      notices: [ACROSS_HIDDEN],
    });
  });

  it('when the native store is alone, then the transfer shows with only the Across notice', () => {
    const batch = readBridgeBatch(contracts, [ETH_STORE], SIGNER);
    expect(batch?.transfer?.title).toBe('Deposit to Across');
    expect(batch?.notices).toEqual([ACROSS_HIDDEN]);
  });

  it('when the store is unreadable, then no transfer shows and its step carries the cannot-read alert', () => {
    const batch = readBridgeBatch(contracts, [APPROVE, { ...USDC_STORE, value: '1' }], SIGNER);
    expect(batch?.transfer).toBeUndefined();
    expect(batch?.steps).toEqual([null, { unreadable: true }]);
  });
});

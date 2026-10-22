import type { ChainClients } from '@jaw.id/agent';
import {
  encodeAbiParameters,
  encodeEventTopics,
  pad,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { acrossDepositId } from './across-deposit';
import type { SwapRow } from './store';

const BASE_SPOKE_POOL: Address = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64';
const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const OTHER: Address = '0x2222222222222222222222222222222222222222';
const TX: Hex = `0x${'ab'.repeat(32)}`;

const LIVE_LOG = {
  address: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64',
  topics: [
    '0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3',
    '0x0000000000000000000000000000000000000000000000000000000000001237',
    '0x0000000000000000000000000000000000000000000000000000000000611473',
    '0x000000000000000000000000dcc3794082223c3680112d9ec9af012579d115b1',
  ],
  data: '0x00000000000000000000000042000000000000000000000000000000000000060000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad73000000000000000000000000000000000000000000000000001131f450b6800000000000000000000000000000000000000000000000000000112c783bf34172000000000000000000000000000000000000000000000000000000006ada4643000000000000000000000000000000000000000000000000000000006ada62630000000000000000000000000000000000000000000000000000000000000000000000000000000000000000dcc3794082223c3680112d9ec9af012579d115b1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000000',
} as const;

const event = parseAbi([
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
]);

type Deposit = { depositor: Address; depositId: bigint; token: Address; amount: bigint; destination: bigint };
const ours: Deposit = { depositor: ACCOUNT, depositId: 7n, token: BASE_USDC, amount: 1_000_000n, destination: 42161n };

function depositLog(d: Deposit, address: Address = BASE_SPOKE_POOL) {
  const word = (a: Address) => pad(a);
  return {
    address,
    topics: encodeEventTopics({
      abi: event,
      args: { destinationChainId: d.destination, depositId: d.depositId, depositor: word(d.depositor) },
    }),
    data: encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint32' },
        { type: 'uint32' },
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes' },
      ],
      [word(d.token), word(d.token), d.amount, d.amount - 100n, 1, 2, 0, word(d.depositor), word(zeroAddress), '0x']
    ),
  };
}

const row = (fields: Partial<SwapRow> = {}) =>
  ({
    id: 'swp_test',
    originChainId: 8453,
    originToken: BASE_USDC.toLowerCase(),
    amount: '1000000',
    depositor: ACCOUNT,
    destinationChainId: 42161,
    txHash: TX,
    ...fields,
  }) as SwapRow;

function chain(logs: readonly object[]) {
  const asked: { chainId: number; hash: Hex }[] = [];
  const clients: ChainClients = {
    publicClient: (chainId) =>
      ({
        getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
          asked.push({ chainId, hash });
          return { status: 'success', logs: logs as unknown as Log[] };
        },
      }) as unknown as PublicClient,
  };
  return { clients, asked };
}

describe('acrossDepositId', () => {
  it('given the live Base receipt of a native deposit, when read for its row, then the depositId is 6362227', async () => {
    const { clients, asked } = chain([LIVE_LOG]);
    const native = row({
      originToken: zeroAddress,
      amount: '4840000000000000',
      depositor: '0xdcc3794082223c3680112d9ec9af012579d115b1',
      destinationChainId: 4663,
    });

    const found = await acrossDepositId(native, clients);

    expect(found).toEqual({ ok: true, depositId: '6362227' });
    expect(asked).toEqual([{ chainId: 8453, hash: TX }]);
  });

  it("given a bundle holding another account's deposit before ours, when read, then ours is taken", async () => {
    const { clients } = chain([depositLog({ ...ours, depositor: OTHER, depositId: 6n }), depositLog(ours)]);

    expect(await acrossDepositId(row(), clients)).toEqual({ ok: true, depositId: '7' });
  });

  it('given two matching deposits of the account in the receipt, when read, then deposit_ambiguous', async () => {
    const { clients } = chain([depositLog(ours), depositLog({ ...ours, depositId: 8n })]);

    expect(await acrossDepositId(row(), clients)).toEqual({ ok: false, code: 'deposit_ambiguous' });
  });

  it.each([
    ['another depositor', depositLog({ ...ours, depositor: OTHER })],
    ['another input token', depositLog({ ...ours, token: OTHER })],
    ['another amount', depositLog({ ...ours, amount: 999_999n })],
    ['another destination chain', depositLog({ ...ours, destination: 10n })],
    ['a contract that is not the allowlisted SpokePool', depositLog(ours, OTHER)],
  ])('given a receipt whose only deposit has %s, when read, then deposit_not_found', async (_, log) => {
    const { clients } = chain([log]);

    expect(await acrossDepositId(row(), clients)).toEqual({ ok: false, code: 'deposit_not_found' });
  });

  it('given a native row whose deposit names WETH as input, when read, then it matches through wrappedNative', async () => {
    const weth: Address = '0x4200000000000000000000000000000000000006';
    const { clients } = chain([depositLog({ ...ours, token: weth })]);

    expect(await acrossDepositId(row({ originToken: zeroAddress }), clients)).toEqual({ ok: true, depositId: '7' });
  });

  it('given an origin chain with no Across entry, when read, then deposit_not_found and no receipt is asked', async () => {
    const { clients, asked } = chain([depositLog(ours)]);

    expect(await acrossDepositId(row({ originChainId: 100 }), clients)).toEqual({
      ok: false,
      code: 'deposit_not_found',
    });
    expect(asked).toEqual([]);
  });

  it('given the receipt cannot be read, when read, then receipt_missing without throwing', async () => {
    const clients: ChainClients = {
      publicClient: () =>
        ({
          getTransactionReceipt: async () => {
            throw new Error('TransactionReceiptNotFoundError');
          },
        }) as unknown as PublicClient,
    };

    expect(await acrossDepositId(row(), clients)).toEqual({ ok: false, code: 'receipt_missing' });
  });
});

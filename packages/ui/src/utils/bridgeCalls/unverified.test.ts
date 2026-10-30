import { describe, expect, it } from 'vitest';
import { getAddress, hashStruct, type Address, type Hex } from 'viem';
import { readBridgeBatch, readBridgeBatchWithUnread } from './batch';
import { BRIDGE_CHAINS } from './contracts';
import { ACROSS_CALLS, RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT, RELAY_USDC_ORDER, SIGNER } from './fixtures';
import { ORDER_TYPES } from './relayOrder';
import { readTokens } from './readTokens';
import { BridgeContracts } from './table';
import { nodeFor, type Answer } from './tokenNode';
import type { BridgeCall } from './view';

const contracts = new BridgeContracts({ version: 1, chains: BRIDGE_CHAINS });

const BASE_SPOKE_POOL = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64';
const AAPL = getAddress('0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9');
const BOUGHT = getAddress('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
const OP_USDT = '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58';
const EURE = '0x3231Cb76718CDeF2155FC47b5286d82e6eDA273f';

const NOT_ACCOUNT = [
  'The recipient is not this account: 0x1111111111111111111111111111111111111111.',
  'The refund address is not this account: 0x1111111111111111111111111111111111111111.',
];
const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const approve = (spender: string, amount = '989680'): BridgeCall => ({
  ...RELAY_USDC_APPROVE,
  data: '0x095ea7b3' + word(spender) + word(amount),
});
const swapToStock = [approve(BASE_SPOKE_POOL), ACROSS_CALLS.usdcToNvdaFee];

// What the screen does end to end: decode, ask the tokens it does not know, decode again.
async function read(calls: BridgeCall[], tokens: Record<string, Answer>, order?: unknown) {
  const first = readBridgeBatchWithUnread(contracts, calls, SIGNER, order);
  const reads = await readTokens(first?.unread ?? [], nodeFor(tokens));
  return readBridgeBatch(contracts.withReads(reads), calls, SIGNER, order);
}
const answer = (address: string, a: Answer) => ({ [address.toLowerCase()]: a });

describe('given an Across swap that buys a token outside the table', () => {
  it('when the token answers, then the batch asks for it and shows its amount in its own units, with a notice', async () => {
    const first = readBridgeBatchWithUnread(contracts, swapToStock, SIGNER);
    expect(first?.unread).toEqual([{ chainId: 4663, address: BOUGHT }]);

    const batch = await read(swapToStock, answer(BOUGHT, { symbol: 'AAPL', decimals: 18n }));
    const token = batch?.transfer?.receive?.amount.token;
    expect(token).toEqual({ address: BOUGHT, known: false, unverified: true, symbol: 'AAPL', decimals: 18 });
    expect(batch?.transfer?.details.find((d) => d.label === 'Fee')?.value).toMatch(/^0\.\d+ AAPL to JAW$/);
    expect(batch?.notices).toEqual([
      ...NOT_ACCOUNT,
      `This screen has not verified the token AAPL (${BOUGHT.slice(0, 6)}...${BOUGHT.slice(-4)}). Check it before you confirm.`,
    ]);
  });

  it.each([
    ['decimals() reverts', { symbol: 'AAPL', revert: 'decimals' }],
    ['there is no code', { code: false }],
    ['decimals is 255', { symbol: 'AAPL', decimals: 255n }],
  ] as [string, Answer][])('when %s, then it reads exactly as before', async (_, a) => {
    const batch = await read(swapToStock, answer(BOUGHT, a));
    expect(batch).toEqual(readBridgeBatch(contracts, swapToStock, SIGNER));
    expect(batch?.transfer?.receive?.amount.token).toEqual({ address: BOUGHT, known: false });
    expect(batch?.notices).toEqual([
      ...NOT_ACCOUNT,
      `This screen does not know the token ${BOUGHT}. Check it before you confirm.`,
    ]);
  });

  it('when the token calls itself USDC, then it is still unverified and still named by its address', async () => {
    const batch = await read(swapToStock, answer(BOUGHT, { symbol: 'USDC', decimals: 6n }));
    const token = batch?.transfer?.receive?.amount.token;
    expect(token).toMatchObject({ known: false, unverified: true, symbol: 'USDC' });
    expect(batch?.notices?.[NOT_ACCOUNT.length]).toContain(`not verified the token USDC (${BOUGHT.slice(0, 6)}`);
  });

  it('when the token is pinned, then nothing is asked and its symbol is trusted', () => {
    const first = readBridgeBatchWithUnread(contracts, [approve(BASE_SPOKE_POOL), ACROSS_CALLS.prod], SIGNER);
    expect(first?.unread).toEqual([]);
    expect(first?.batch.transfer?.receive?.amount.token).toMatchObject({ known: true, symbol: 'USDC' });
  });

  it('when a pinned address is answered with another symbol, then the pin wins', () => {
    const reads = new Map([[`8453:${'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'}`, { symbol: 'FAKE', decimals: 2 }]]);
    const batch = readBridgeBatch(contracts.withReads(reads), [approve(BASE_SPOKE_POOL), ACROSS_CALLS.prod], SIGNER);
    expect(batch?.transfer?.send.token).toMatchObject({ known: true, symbol: 'USDC', decimals: 6 });
  });
});

describe('given an approve for a token outside the table', () => {
  const unknown = getAddress(`0x${'ab'.repeat(20)}`);
  const unknownApprove: BridgeCall = { ...approve(BASE_SPOKE_POOL), to: unknown };

  it('when it is read, then the batch asks for the token and the approve notice stays', async () => {
    expect(readBridgeBatchWithUnread(contracts, [unknownApprove], SIGNER)?.unread).toEqual([
      { chainId: 8453, address: unknown },
    ]);
    const batch = await read([unknownApprove], answer(unknown, { symbol: 'AAPL', decimals: 18n }));
    expect(batch?.notices).toContain(
      'This batch approves a token this screen does not know. Check its address before you confirm.'
    );
  });
});

describe('given a Relay order that pays out a token', () => {
  type Order = typeof RELAY_USDC_ORDER;
  const toToken = (chain: string, currency: string, minimumAmount: string): Order => {
    const order = structuredClone(RELAY_USDC_ORDER);
    order.output.chainId = chain;
    order.output.payments[0].currency = currency;
    order.output.payments[0].minimumAmount = minimumAmount;
    order.inputs[0].refunds[1].chainId = chain;
    order.inputs[0].refunds[1].currency = currency;
    return order;
  };
  const batchFor = (order: Order, tokens: Record<string, Answer> = {}) => {
    const id = hashStruct({ types: ORDER_TYPES, primaryType: 'Order', data: order as never }) as Hex;
    const deposit = { ...RELAY_USDC_DEPOSIT, data: (RELAY_USDC_DEPOSIT.data ?? '').slice(0, -64) + id.slice(2) };
    return read([RELAY_USDC_APPROVE, deposit], tokens, { optional: true, orderData: order });
  };
  const received = async (order: Order, tokens?: Record<string, Answer>) =>
    (await batchFor(order, tokens))?.transfer?.receive?.amount;

  it('when it pays USDT on Optimism, then the terms show 6 decimals and a trusted symbol', async () => {
    const amount = await received(toToken('optimism', OP_USDT.toLowerCase(), '9500000'));
    expect(amount).toMatchObject({
      chainId: 10,
      amount: 9_500_000n,
      token: { known: true, symbol: 'USDT', decimals: 6 },
    });
  });

  it('when it pays EURe on Ethereum, then the terms show 18 decimals and a trusted symbol', async () => {
    const amount = await received(toToken('ethereum', EURE.toLowerCase(), '9000000000000000000'));
    expect(amount).toMatchObject({ chainId: 1, token: { known: true, symbol: 'EURe', decimals: 18 } });
  });

  it('when it pays a token that answers, then the terms show with a notice, not the order is hidden', async () => {
    const order = toToken('robinhood', AAPL.toLowerCase(), '2500000000000000000');
    const first = readBridgeBatchWithUnread(contracts, [RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT], SIGNER);
    expect(first?.unread).toEqual([]);

    const batch = await batchFor(order, answer(AAPL, { symbol: 'AAPL', decimals: 18n }));
    expect(batch?.transfer?.title).toBe('Bridge to Robinhood Chain');
    expect(batch?.transfer?.receive?.amount).toMatchObject({
      chainId: 4663,
      amount: 2_500_000_000_000_000_000n,
      token: { known: false, unverified: true, symbol: 'AAPL', decimals: 18 },
    });
    expect(
      batch?.notices.some((n) => n.startsWith('This screen has not verified the token AAPL (0xaF3D...93f9)'))
    ).toBe(true);
  });

  it('when that token cannot be read, then the order stays hidden as an unrecognized token', async () => {
    const order = toToken('robinhood', AAPL.toLowerCase(), '2500000000000000000');
    const batch = await batchFor(order, answer(AAPL, { code: false }));
    expect(batch?.transfer?.receive).toBeUndefined();
    expect(batch?.notices).toContain('This Relay order includes an unrecognized token, so its terms are not shown.');
  });

  it('when the order hides a token, then the batch asks for it on its own chain', () => {
    const order = toToken('robinhood', AAPL.toLowerCase(), '2500000000000000000');
    const id = hashStruct({ types: ORDER_TYPES, primaryType: 'Order', data: order as never }) as Hex;
    const deposit = { ...RELAY_USDC_DEPOSIT, data: (RELAY_USDC_DEPOSIT.data ?? '').slice(0, -64) + id.slice(2) };
    const first = readBridgeBatchWithUnread(contracts, [RELAY_USDC_APPROVE, deposit], SIGNER, { orderData: order });
    expect(first?.unread).toEqual([{ chainId: 4663, address: AAPL.toLowerCase() as Address }]);
  });
});

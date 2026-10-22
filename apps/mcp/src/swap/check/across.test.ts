import { describe, expect, it } from 'vitest';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  maxUint256,
  pad,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { callsOf } from '../calls';
import { checkQuote, type CheckCode, type QuoteRequest } from '../check';
import degenToUsdc from '../fixtures/across-degen-to-usdc.json';
import ethToEthMainnet from '../fixtures/across-eth-to-eth-mainnet.json';
import ethToUsdc from '../fixtures/across-eth-to-usdc.json';
import nativeEth from '../fixtures/across-native-eth.json';
import nativeFee from '../fixtures/across-native-fee.json';
import usdcFee from '../fixtures/across-usdc-fee.json';
import usdcNofee from '../fixtures/across-usdc-nofee.json';
import usdcOtherRecipient from '../fixtures/across-usdc-other-recipient.json';
import usdcToArb from '../fixtures/across-usdc-to-arb.json';
import usdcToWeth from '../fixtures/across-usdc-to-weth.json';
import prod from '../fixtures/prod-across-quote.json';

const ACCOUNT = getAddress('0x6ca44a56b06869530c953dfa7868973be1456769');
const OTHER = getAddress('0x1111111111111111111111111111111111111111');
const ATTACKER = getAddress('0x2222222222222222222222222222222222222222');
const BASE_USDC = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
const BASE_WETH = getAddress('0x4200000000000000000000000000000000000006');
const ARB_USDC = getAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
const ARB_WETH = getAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1');
const BASE_POOL = getAddress('0x09aea4b2242abc8bb4bb78d537a67a245a7bec64');
const PERIPHERY = getAddress('0x97ccdbea4632140639ad5ea9b944aa034eb15fd4');
const HANDLER = getAddress('0x0f7ae28de1c8532170ad4ee566b5801485c13a0e');
const FEE_RECIPIENT = getAddress('0xc529edd6d47c60923902514c7c0b3993ae42c2ec');
const BASE_SEPOLIA_USDC = getAddress('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
const BASE_SEPOLIA_POOL = getAddress('0x82b564983ae7274c86695917bbf8c99ecb6f0f8f');
const SEPOLIA_USDC = getAddress('0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');

type Tx = { chainId: number; to: string; data: string; value: string };
type Body = {
  quoteId: string;
  provider: string;
  inputAmount: string;
  expectedOutputAmount: string;
  minOutputAmount: string;
  expectedFillTimeSec: number;
  fees: { totalUsd?: string };
  transactions: Tx[];
  deposit?: unknown;
};
type Token = { address: string; chainId: number };
type Raw = {
  id: string;
  inputAmount: string;
  expectedOutputAmount: string;
  minOutputAmount: string;
  expectedFillTime: number;
  inputToken: Token;
  outputToken: Token;
  fees: { total: { amountUsd: string } };
  approvalTxns?: Array<{ chainId: number; to: string; data: string }>;
  swapTx: { chainId: number; to: string; data: string; value?: string };
};
type Case = { request: QuoteRequest; body: Body; now: number };

const RAW: Record<string, unknown> = {
  degen_to_usdc: degenToUsdc,
  eth_to_eth_mainnet: ethToEthMainnet,
  eth_to_usdc: ethToUsdc,
  native_eth: nativeEth,
  native_fee: nativeFee,
  usdc_fee: usdcFee,
  usdc_nofee: usdcNofee,
  usdc_other_recipient: usdcOtherRecipient,
  usdc_to_arb: usdcToArb,
  usdc_to_weth: usdcToWeth,
};

// Same mapping as AcrossMoveAssetMapper.mapToQuote in jan-back-mono apps/proxy.
function moveAssetQuote(raw: Raw): Body {
  return {
    quoteId: `across:${raw.id}`,
    provider: 'across',
    inputAmount: raw.inputAmount,
    expectedOutputAmount: raw.expectedOutputAmount,
    minOutputAmount: raw.minOutputAmount,
    expectedFillTimeSec: raw.expectedFillTime,
    fees: { totalUsd: raw.fees.total.amountUsd },
    transactions: [
      ...(raw.approvalTxns ?? []).map((tx) => ({ chainId: tx.chainId, to: tx.to, data: tx.data, value: '0' })),
      { chainId: raw.swapTx.chainId, to: raw.swapTx.to, data: raw.swapTx.data, value: raw.swapTx.value ?? '0' },
    ],
  };
}

const quotedAt = (quoteId: string) => Math.floor(Number(quoteId.split('-')[1]) / 1000);

function live(name: string): Case {
  if (name === 'prod') {
    const body = structuredClone(prod.result.data) as Body;
    const request = requestOf(BASE_USDC, '10000000', 42161, ARB_USDC, ACCOUNT);
    return { request, body, now: quotedAt(body.quoteId) };
  }
  const raw = structuredClone(RAW[name]) as Raw;
  const recipient = name === 'usdc_other_recipient' ? OTHER : ACCOUNT;
  const { inputToken, outputToken } = raw;
  const request = requestOf(inputToken.address, raw.inputAmount, outputToken.chainId, outputToken.address, recipient);
  return { request, body: moveAssetQuote(raw), now: quotedAt(raw.id) };
}

function requestOf(token: string, amount: string, destinationChainId: number, out: string, recipient: Address) {
  return {
    originChainId: 8453,
    originToken: getAddress(token),
    amount,
    account: ACCOUNT,
    destinationChainId,
    destinationToken: out.toLowerCase(),
    recipient: recipient.toLowerCase(),
  };
}

const depositAbi = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
]);
const handlerAbi = parseAbi(['function drainLeftoverTokens(address token, address destination)']);
const instructionsAbi = parseAbiParameters(
  '((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)'
);

type DepositArgs = {
  depositor: Hex;
  recipient: Hex;
  inputToken: Hex;
  outputToken: Hex;
  inputAmount: bigint;
  outputAmount: bigint;
  destinationChainId: bigint;
  exclusiveRelayer: Hex;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityParameter: number;
  message: Hex;
};
type Call = { target: Address; callData: Hex; value: bigint };

const word = (address: string) => pad(address.toLowerCase() as Hex, { size: 32 });

function withDeposit(c: Case, edit: (args: DepositArgs) => void, suffix = '73c0de'): Case {
  const tx = c.body.transactions[c.body.transactions.length - 1];
  const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, ...rest] = decodeFunctionData({
    abi: depositAbi,
    data: tx.data as Hex,
  }).args;
  const [destinationChainId, exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityParameter, message] = rest;
  const a: DepositArgs = {
    ...{ depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId },
    ...{ exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityParameter, message },
  };
  edit(a);
  const args = [a.depositor, a.recipient, a.inputToken, a.outputToken, a.inputAmount, a.outputAmount] as const;
  const tail = [a.exclusiveRelayer, a.quoteTimestamp, a.fillDeadline, a.exclusivityParameter, a.message] as const;
  const data = encodeFunctionData({
    abi: depositAbi,
    functionName: 'deposit',
    args: [...args, a.destinationChainId, ...tail],
  });
  tx.data = `${data}${suffix}`;
  return c;
}

function withCalls(c: Case, edit: (calls: Call[]) => Call[], fallbackRecipient: Address = zeroAddress): Case {
  return withDeposit(c, (args) => {
    const [{ calls }] = decodeAbiParameters(instructionsAbi, args.message);
    args.message = encodeAbiParameters(instructionsAbi, [{ calls: edit([...calls]), fallbackRecipient }]);
  });
}

const feeCall = (amount: bigint, to: Address = FEE_RECIPIENT, token: Address = ARB_USDC): Call => ({
  target: token,
  callData: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  value: 0n,
});
const drainCall = (token: Address = ARB_USDC, to: Address = ACCOUNT, target: Address = HANDLER): Call => ({
  target,
  callData: encodeFunctionData({ abi: handlerAbi, functionName: 'drainLeftoverTokens', args: [token, to] }),
  value: 0n,
});
const approveData = (spender: Address, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });

const fee = () => live('usdc_fee');
const tagged = (suffix: string) => withDeposit(fee(), (a) => a, suffix);
const nofee = () => live('usdc_nofee');

function minOutput(c: Case, amount: string): Case {
  c.body.minOutputAmount = amount;
  c.body.expectedOutputAmount = amount;
  return c;
}

function edited(c: Case, edit: (c: Case) => void): Case {
  edit(c);
  return c;
}

// Base Sepolia USDC to Sepolia USDC, built from the live fee quote with the testnet addresses.
function testnet(withEmit: boolean): Case {
  const c = fee();
  c.request = { ...c.request, originChainId: 84532, originToken: BASE_SEPOLIA_USDC, destinationChainId: 11155111 };
  c.request.destinationToken = SEPOLIA_USDC.toLowerCase();
  const [approve, deposit] = c.body.transactions;
  approve.to = BASE_SEPOLIA_USDC;
  approve.data = approveData(BASE_SEPOLIA_POOL, maxUint256);
  deposit.to = BASE_SEPOLIA_POOL;
  for (const tx of c.body.transactions) tx.chainId = 84532;
  withDeposit(c, (a) => {
    a.inputToken = word(BASE_SEPOLIA_USDC);
    a.outputToken = word(SEPOLIA_USDC);
    a.destinationChainId = 11155111n;
  });
  return withCalls(c, (calls) => [
    feeCall(24965n, FEE_RECIPIENT, SEPOLIA_USDC),
    drainCall(SEPOLIA_USDC),
    ...(withEmit ? [calls[3]] : []),
  ]);
}

// A one-byte message leaves 31 padding bytes before the tag; the last one is set.
function dirtyPadding(): Case {
  const c = withDeposit(nofee(), (a) => (a.message = '0x12'));
  const tx = c.body.transactions[1];
  tx.data = `${tx.data.slice(0, -8)}ff73c0de`;
  return c;
}

// WETH on Base to native ETH on Arbitrum, the deposit naming the zero address as its output token.
function wethToNative(): Case {
  const c = nofee();
  c.request = { ...c.request, originToken: BASE_WETH, destinationToken: zeroAddress };
  c.body.transactions[0].to = BASE_WETH;
  return withDeposit(c, (a) => {
    a.inputToken = word(BASE_WETH);
    a.outputToken = word(zeroAddress);
  });
}

async function outcome(c: Case): Promise<'pass' | CheckCode> {
  const result = await checkQuote(c.request, c.body, { isDepositAddressTaken: async () => false, now: () => c.now });
  if (!result.ok) return result.code;
  expect(callsOf({ call: result.calls })).toEqual(result.calls);
  return 'pass';
}

async function accepted(c: Case) {
  const result = await checkQuote(c.request, c.body, { isDepositAddressTaken: async () => false, now: () => c.now });
  if (!result.ok) throw new Error(`expected the quote to pass, got ${result.code}`);
  expect(callsOf({ call: result.calls })).toEqual(result.calls);
  return result;
}

describe('given each live Across answer with the request it was made for', () => {
  it.each([
    ['prod', 'pass'],
    ['usdc_fee', 'pass'],
    ['usdc_nofee', 'pass'],
    ['usdc_other_recipient', 'pass'],
    ['usdc_to_weth', 'route_unsupported'],
    ['degen_to_usdc', 'route_unsupported'],
    ['eth_to_usdc', 'route_unsupported'],
    ['usdc_to_arb', 'route_unsupported'],
    ['native_eth', 'tx_selector'],
    ['native_fee', 'tx_selector'],
    ['eth_to_eth_mainnet', 'tx_selector'],
  ])('when %s is checked, then the answer is %s', async (name, expected) => {
    expect(await outcome(live(name))).toBe(expected);
  });
});

describe('given an Across ERC-20 quote that passes', () => {
  it('when the prod quote with an unlimited approve is accepted, then the approve is rebuilt for the amount and the deposit kept as given', async () => {
    const c = live('prod');
    const deposit = c.body.transactions[1].data;

    const result = await accepted(c);

    expect(result).toEqual({
      ok: true,
      provider: 'across',
      quoteId: 'across:84z7t-1792622110214-a21c2a19ac82',
      calls: [
        { kind: 'approve', chainId: 8453, to: BASE_USDC, data: approveData(BASE_POOL, 10_000_000n), value: '0' },
        { kind: 'deposit', chainId: 8453, to: BASE_POOL, data: deposit, value: '0' },
      ],
      quote: {
        provider: 'across',
        inputAmount: '10000000',
        expectedOutputAmount: '9960900',
        minOutputAmount: '9960900',
        expectedFillTimeSec: 1,
        feesUsd: '0.039100000000000003',
        deadline: 1792629035,
        appFee: '24964',
      },
    });
    expect(result.calls.map((call) => call.data)).not.toContain(c.body.transactions[0].data);
  });

  it('when the quote has an empty message, then the app fee is 0 and the deadline is its fillDeadline', async () => {
    const result = await accepted(nofee());

    expect(result.quote).toMatchObject({ appFee: '0', deadline: 1792683695, minOutputAmount: '9990214' });
  });

  it('when the quote leaves the approve out, then the stored calls still start with approve(SpokePool, amount)', async () => {
    const c = fee();
    c.body.transactions = [c.body.transactions[1]];

    const result = await accepted(c);

    expect(result.calls.map((call) => call.kind)).toEqual(['approve', 'deposit']);
    expect(result.calls[0].data).toBe(approveData(BASE_POOL, 10_000_000n));
  });

  it('when it runs between two testnets, then it passes with the testnet SpokePool as spender', async () => {
    const result = await accepted(testnet(false));

    expect(result.calls[0]).toEqual({
      kind: 'approve',
      chainId: 84532,
      to: BASE_SEPOLIA_USDC,
      data: approveData(BASE_SEPOLIA_POOL, 10_000_000n),
      value: '0',
    });
  });

  it.each<[string, () => Case]>([
    ['a quoteId of 64 characters', () => edited(fee(), (c) => (c.body.quoteId = `across:${'a'.repeat(64)}`))],
    ['the integrator tag before the Across tag', () => tagged('1dc0de016173c0de')],
    ['a fillDeadline exactly 6 hours away', () => withDeposit(fee(), (a) => (a.fillDeadline = fee().now + 21600))],
    ['an exclusivity of 60 seconds', () => withDeposit(fee(), (a) => (a.exclusivityParameter = 60))],
    [
      'no fee call and the output equal to the minimum',
      () =>
        minOutput(
          withCalls(fee(), (c) => c.slice(1)),
          '9986164'
        ),
    ],
    ['one drain and no emitData', () => withCalls(fee(), (c) => c.slice(0, 2))],
    ['two emitData calls', () => withCalls(fee(), (c) => [...c, c[3]])],
  ])('when it has %s, then it passes', async (_, make) => {
    expect(await outcome(make())).toBe('pass');
  });
});

const refusals: Array<[string, () => Case, CheckCode]> = [
  ['a quoteId with a space', () => edited(fee(), (c) => (c.body.quoteId = 'across:a b')), 'quote_id'],
  ['a quoteId of 65 characters', () => edited(fee(), (c) => (c.body.quoteId = `across:${'a'.repeat(65)}`)), 'quote_id'],
  ['a relay id', () => edited(fee(), (c) => (c.body.quoteId = `relay:0x${'1'.repeat(64)}`)), 'quote_id'],
  ['a deposit field', () => edited(fee(), (c) => (c.body.deposit = { address: OTHER })), 'quote_id'],
  [
    'a Solana destination',
    () =>
      edited(fee(), (c) => {
        c.request.destinationChainId = 792703809;
        c.request.destinationToken = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        c.request.recipient = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
      }),
    'quote_id',
  ],
  [
    'an inputAmount other than the amount',
    () => edited(fee(), (c) => (c.body.inputAmount = '9999999')),
    'input_amount',
  ],
  ['a deposit of another amount', () => withDeposit(fee(), (a) => (a.inputAmount = 9_999_999n)), 'input_amount'],
  ['a deposit of another token', () => withDeposit(fee(), (a) => (a.inputToken = word(OTHER))), 'input_amount'],
  [
    'a minimum above the expected output',
    () => edited(fee(), (c) => (c.body.expectedOutputAmount = '9961198')),
    'output_amount',
  ],
  ['a minimum of 0', () => minOutput(fee(), '0'), 'output_amount'],
  ['a fee program that pays out less than the minimum', () => minOutput(fee(), '9961198'), 'output_amount'],
  ['an empty message that pays out other than the minimum', () => minOutput(nofee(), '9990213'), 'output_amount'],
  ['a minimum of 1 base unit', () => edited(fee(), (c) => (c.body.minOutputAmount = '1')), 'output_floor'],
  ['a minimum 1 unit under the 300 bps floor', () => minOutput(fee(), '9699999'), 'output_floor'],
  ['a transaction on another chain', () => edited(fee(), (c) => (c.body.transactions[0].chainId = 42161)), 'tx_chain'],
  [
    'an origin chain Across has no entry for',
    () => edited(fee(), (c) => (c.request.originChainId = 100)),
    'unsupported_chain',
  ],
  [
    'a destination chain Across has no entry for',
    () => edited(fee(), (c) => (c.request.destinationChainId = 4663)),
    'destination_chain',
  ],
  [
    'a mainnet origin and a testnet destination',
    () =>
      edited(fee(), (c) => {
        c.request.destinationChainId = 11155111;
        c.request.destinationToken = SEPOLIA_USDC.toLowerCase();
      }),
    'destination_chain',
  ],
  [
    'a testnet origin and a mainnet destination',
    () =>
      edited(fee(), (c) => {
        c.request.originChainId = 84532;
        c.request.originToken = BASE_SEPOLIA_USDC;
      }),
    'destination_chain',
  ],
  ['a deposit to another chain', () => withDeposit(fee(), (a) => (a.destinationChainId = 10n)), 'destination_chain'],
  [
    'an origin swap (swapAndBridge) on a same-asset request',
    () => ({ ...live('usdc_to_weth'), request: fee().request }),
    'route_unsupported',
  ],
  [
    'a destination swap message on a same-asset request',
    () => ({ ...live('usdc_to_arb'), request: fee().request }),
    'route_unsupported',
  ],
  ['no transaction', () => edited(fee(), (c) => (c.body.transactions = [])), 'tx_count'],
  [
    'three transactions',
    () => edited(fee(), (c) => c.body.transactions.unshift({ ...c.body.transactions[0] })),
    'tx_count',
  ],
  [
    'an approve to the periphery',
    () => edited(fee(), (c) => (c.body.transactions[0].data = approveData(PERIPHERY, maxUint256))),
    'approve_spender',
  ],
  ['an approve on another token', () => edited(fee(), (c) => (c.body.transactions[0].to = OTHER)), 'approve_spender'],
  [
    'a transfer in place of the approve',
    () =>
      edited(fee(), (c) => {
        c.body.transactions[0].data = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [BASE_POOL, 10_000_000n],
        });
      }),
    'approve_spender',
  ],
  [
    'an unknown deposit selector',
    () => edited(fee(), (c) => (c.body.transactions[1].data = `0xdeadbeef${c.body.transactions[1].data.slice(10)}`)),
    'tx_selector',
  ],
  [
    'a native origin',
    () =>
      edited(fee(), (c) => {
        c.request.originToken = zeroAddress;
        c.request.destinationToken = ARB_WETH.toLowerCase();
      }),
    'tx_selector',
  ],
  ['a deposit to the periphery', () => edited(fee(), (c) => (c.body.transactions[1].to = PERIPHERY)), 'tx_to'],
  ['a deposit carrying value', () => edited(fee(), (c) => (c.body.transactions[1].value = '1')), 'tx_value'],
  [
    'bytes after the Across tag',
    () => edited(fee(), (c) => (c.body.transactions[1].data = `${c.body.transactions[1].data}deadbeef`)),
    'tx_data',
  ],
  ['no Across tag', () => tagged(''), 'tx_data'],
  ['a short integrator tag', () => tagged('1dc0de0173c0de'), 'tx_data'],
  ['a byte between the tags', () => tagged('1dc0de0161ff73c0de'), 'tx_data'],
  [
    'calldata that does not decode',
    () => edited(fee(), (c) => (c.body.transactions[1].data = '0xad5425c600')),
    'tx_data',
  ],
  ['dirty padding inside the ABI payload', dirtyPadding, 'tx_data'],
  ['another depositor', () => withDeposit(fee(), (a) => (a.depositor = word(ATTACKER))), 'depositor'],
  [
    'the depositor with high bytes set',
    () => withDeposit(fee(), (a) => (a.depositor = `0x000000000000000000000001${ACCOUNT.slice(2).toLowerCase()}`)),
    'depositor',
  ],
  ['another output token', () => withDeposit(fee(), (a) => (a.outputToken = word(OTHER))), 'output_token'],
  ['a native destination with a zero output token', wethToNative, 'output_token'],
  [
    'an empty message to another recipient',
    () => withDeposit(nofee(), (a) => (a.recipient = word(ATTACKER))),
    'recipient',
  ],
  [
    'an empty message to the recipient with high bytes set',
    () => withDeposit(nofee(), (a) => (a.recipient = `0x000000000000000000000001${ACCOUNT.slice(2).toLowerCase()}`)),
    'recipient',
  ],
  ['a message with the user as recipient', () => withDeposit(fee(), (a) => (a.recipient = word(ACCOUNT))), 'recipient'],
  ['a fillDeadline already passed', () => withDeposit(fee(), (a) => (a.fillDeadline = fee().now)), 'deadline'],
  [
    'a fillDeadline over 6 hours away',
    () => withDeposit(fee(), (a) => (a.fillDeadline = fee().now + 21601)),
    'deadline',
  ],
  ['an exclusivity of 61 seconds', () => withDeposit(fee(), (a) => (a.exclusivityParameter = 61)), 'exclusivity'],
  [
    'a fee of 1 unit over 25 bps',
    () =>
      minOutput(
        withCalls(fee(), (c) => [feeCall(24966n), ...c.slice(1)]),
        '9961198'
      ),
    'app_fee',
  ],
  ['an emitData on a chain with no emitter', () => testnet(true), 'message_program'],
];

describe('given an Across quote that breaks one rule', () => {
  it.each(refusals.map(([what, make, code]) => [what, code, make] as const))(
    'when it has %s, then it is refused with %s',
    async (_, code, make) => {
      expect(await outcome(make())).toBe(code);
    }
  );
});

describe('given the fee message program [fee, drain, drain, emitData]', () => {
  it.each<[string, (calls: Call[]) => Call[]]>([
    ['the fee sent to another address', (c) => [feeCall(24965n, ATTACKER), ...c.slice(1)]],
    ['the fee paid in another token', (c) => [feeCall(24965n, FEE_RECIPIENT, OTHER), ...c.slice(1)]],
    ['the fee call carrying value', (c) => [{ ...c[0], value: 1n }, ...c.slice(1)]],
    ['two fee calls', (c) => [c[0], ...c]],
    ['a drain to another address', (c) => [c[0], drainCall(ARB_USDC, ATTACKER), c[3]]],
    ['a drain of another token', (c) => [c[0], drainCall(OTHER), c[3]]],
    ['a drain through another contract', (c) => [c[0], drainCall(ARB_USDC, ACCOUNT, OTHER), c[3]]],
    ['a drain carrying value', (c) => [c[0], { ...c[1], value: 1n }, c[3]]],
    ['no drain', (c) => [c[0], c[3]]],
    ['three drains', (c) => [c[0], c[1], c[1], c[1], c[3]]],
    ['the fee after the drains', (c) => [c[1], c[0], c[3]]],
    ['emitData before the drain', (c) => [c[0], c[3], c[1]]],
    ['three emitData calls', (c) => [...c, c[3], c[3]]],
    ['emitData on another contract', (c) => [c[0], c[1], { ...c[3], target: OTHER }]],
    ['emitData with a trailing byte', (c) => [c[0], c[1], { ...c[3], callData: `${c[3].callData}ff` }]],
    ['an extra transfer at the end', (c) => [...c, feeCall(1n, ACCOUNT)]],
    [
      'an approve in place of the fee transfer',
      (c) => [{ ...c[0], callData: approveData(FEE_RECIPIENT, 24965n) }, ...c.slice(1)],
    ],
    ['the fee transfer with a trailing byte', (c) => [{ ...c[0], callData: `${c[0].callData}00` }, ...c.slice(1)]],
  ])('when the message has %s, then it is refused with message_program', async (_, edit) => {
    expect(await outcome(withCalls(fee(), edit))).toBe('message_program');
  });

  it('when the fallbackRecipient is not zero, then it is refused with message_program', async () => {
    expect(await outcome(withCalls(fee(), (c) => c, ACCOUNT))).toBe('message_program');
  });

  it('when the message has trailing bytes or does not decode, then it is refused with message_program', async () => {
    const trailing = withDeposit(fee(), (a) => (a.message = `${a.message}00`));
    const garbage = withDeposit(fee(), (a) => (a.message = '0x1234'));

    expect(await outcome(trailing)).toBe('message_program');
    expect(await outcome(garbage)).toBe('message_program');
  });
});

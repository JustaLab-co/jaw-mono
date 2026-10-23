import { describe, expect, it } from 'vitest';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  pad,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Hex,
} from 'viem';
import { readAcrossCall } from './across';
import { ACROSS_CALLS } from './fixtures';
import { pinnedToken, type BridgeCall } from './view';

const ACCOUNT = getAddress('0x6ca44a56b06869530c953dfa7868973be1456769');
const OTHER = getAddress('0x1111111111111111111111111111111111111111');
const ATTACKER = getAddress('0x2222222222222222222222222222222222222222');
const BASE_USDC = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
const USDBC = getAddress('0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca');
const ARB_USDC = getAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
const ARB = getAddress('0x912ce59144191c1204e64559fe8253a0e49e6548');
const ARB_WETH = getAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1');
const BSC_USDC = getAddress('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d');
const BSC_POOL = getAddress('0x4e8e101924ede233c13e2d8622dc8aed2872d505');
const HANDLER = getAddress('0x0f7ae28de1c8532170ad4ee566b5801485c13a0e');
const FEE_RECIPIENT = getAddress('0xc529edd6d47c60923902514c7c0b3993ae42c2ec');
const ARC_HANDLER = getAddress('0xa07480456c4ebad7626e4fdf4a180709e238547b');
const ARC_EMITTER = getAddress('0x446fe2be6a8d90fa89f30f3d0a686aaffe621237');

const usdc = (chainId: number, token: string, amount: bigint) => ({
  chainId,
  amount,
  token: { address: getAddress(token), known: true, symbol: 'USDC', decimals: 6 },
});
const eth = (chainId: number, amount: bigint) => ({
  chainId,
  amount,
  token: { address: zeroAddress, known: true, symbol: 'ETH', decimals: 18 },
});
const weth = (chainId: number, amount: bigint) => ({
  chainId,
  amount,
  token: { address: ARB_WETH, known: true, symbol: 'WETH', decimals: 18 },
});

const depositAbi = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
  'function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
]);
const handlerAbi = parseAbi(['function drainLeftoverTokens(address token, address destination)']);
const instructionsAbi = parseAbiParameters(
  '((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)'
);
type Program = { calls: { target: `0x${string}`; callData: Hex; value: bigint }[]; fallbackRecipient: `0x${string}` };

const word = (address: string) => pad(address.toLowerCase() as Hex, { size: 32 });

function withArgs(call: BridgeCall, edit: (args: unknown[]) => void): BridgeCall {
  const decoded = decodeFunctionData({ abi: depositAbi, data: call.data as Hex });
  const tail = (call.data as Hex).slice(encodeFunctionData({ abi: depositAbi, ...decoded }).length);
  const args = [...decoded.args];
  edit(args);
  const data = encodeFunctionData({ abi: depositAbi, functionName: decoded.functionName, args } as never);
  return { ...call, data: data + tail };
}

function withProgram(call: BridgeCall, edit: (program: Program) => void): BridgeCall {
  return withArgs(call, (args) => {
    const [program] = decodeAbiParameters(instructionsAbi, args.at(-1) as Hex);
    const copy = { calls: program.calls.map((c) => ({ ...c })), fallbackRecipient: program.fallbackRecipient };
    edit(copy);
    args[args.length - 1] = encodeAbiParameters(instructionsAbi, [copy]);
  });
}

const drain = (token: string, to: string) => ({
  target: HANDLER,
  callData: encodeFunctionData({
    abi: handlerAbi,
    functionName: 'drainLeftoverTokens',
    args: [getAddress(token), getAddress(to)],
  }),
  value: 0n,
});
const transfer = (token: string, to: string, amount: bigint) => ({
  target: getAddress(token),
  callData: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] }),
  value: 0n,
});

const unreadable = { kind: 'unreadable', provider: 'across' };

describe('given the deposit call of a live Across quote', () => {
  it('then prod Base USDC to Arbitrum reads 10 USDC sent, 9.9609 USDC minimum and a 0.024964 USDC JAW fee', () => {
    expect(readAcrossCall(ACROSS_CALLS.prod)).toEqual({
      kind: 'deposit',
      provider: 'across',
      send: usdc(8453, BASE_USDC, 10_000_000n),
      destinationChainId: 42161,
      recipient: ACCOUNT,
      receive: { kind: 'minimum', amount: usdc(42161, ARB_USDC, 9_960_900n) },
      fee: { amount: usdc(42161, ARB_USDC, 24_964n), recipient: FEE_RECIPIENT, jaw: true },
      refundTo: ACCOUNT,
      fillDeadline: 1792629035,
    });
  });

  it('then the live fee quote reads 9.961199 USDC minimum after a 0.024965 USDC fee', () => {
    const read = readAcrossCall(ACROSS_CALLS.usdcFee);
    expect(read).toMatchObject({
      receive: { kind: 'minimum', amount: usdc(42161, ARB_USDC, 9_961_199n) },
      fee: { amount: usdc(42161, ARB_USDC, 24_965n), recipient: FEE_RECIPIENT, jaw: true },
      fillDeadline: 1792683695,
    });
  });

  it('then an empty message reads the recipient argument, no fee and the whole output as minimum', () => {
    expect(readAcrossCall(ACROSS_CALLS.usdcNofee)).toEqual({
      kind: 'deposit',
      provider: 'across',
      send: usdc(8453, BASE_USDC, 10_000_000n),
      destinationChainId: 42161,
      recipient: ACCOUNT,
      receive: { kind: 'minimum', amount: usdc(42161, ARB_USDC, 9_990_214n) },
      fee: undefined,
      refundTo: ACCOUNT,
      fillDeadline: 1792683695,
    });
  });

  it('then a quote to another recipient names that recipient in full', () => {
    expect(readAcrossCall(ACROSS_CALLS.usdcOtherRecipient)).toMatchObject({
      recipient: OTHER,
      refundTo: ACCOUNT,
      receive: { kind: 'minimum', amount: usdc(42161, ARB_USDC, 9_990_223n) },
      fillDeadline: 1792683935,
    });
  });

  it('then a periphery depositNative reads 0.01 ETH sent and native ETH received on Arbitrum', () => {
    expect(readAcrossCall(ACROSS_CALLS.nativeEth)).toEqual({
      kind: 'deposit',
      provider: 'across',
      send: eth(8453, 10_000_000_000_000_000n),
      destinationChainId: 42161,
      recipient: ACCOUNT,
      receive: { kind: 'minimum', amount: eth(42161, 9_991_147_824_020_099n) },
      fee: undefined,
      refundTo: ACCOUNT,
      fillDeadline: 1792683695,
    });
  });

  it('then a native deposit with a fee reads the value call to JAW and the output less that fee', () => {
    expect(readAcrossCall(ACROSS_CALLS.nativeFee)).toMatchObject({
      receive: { kind: 'minimum', amount: eth(42161, 9_966_189_341_685_642n) },
      fee: { amount: eth(42161, 24_977_918_149_588n), recipient: FEE_RECIPIENT, jaw: true },
      fillDeadline: 1792683935,
    });
  });

  it('then ETH to mainnet reads Ethereum as the destination and native ETH there', () => {
    expect(readAcrossCall(ACROSS_CALLS.ethToEthMainnet)).toMatchObject({
      destinationChainId: 1,
      receive: { kind: 'minimum', amount: eth(1, 9_920_000_555_340_732n) },
      fee: undefined,
    });
  });

  it('then a swap on Base from USDC into WETH reads 10 USDC sent and WETH received on Arbitrum', () => {
    expect(readAcrossCall(ACROSS_CALLS.usdcToWeth)).toEqual({
      kind: 'deposit',
      provider: 'across',
      send: usdc(8453, BASE_USDC, 10_000_000n),
      destinationChainId: 42161,
      recipient: ACCOUNT,
      receive: { kind: 'minimum', amount: weth(42161, 4_115_263_786_415_490n) },
      fee: undefined,
      refundTo: ACCOUNT,
      fillDeadline: 1792683695,
    });
  });

  it('then a swap on Base from ETH into USDC reads 0.01 ETH sent and USDC received on Arbitrum', () => {
    expect(readAcrossCall(ACROSS_CALLS.ethToUsdc)).toMatchObject({
      send: eth(8453, 10_000_000_000_000_000n),
      recipient: ACCOUNT,
      receive: { kind: 'minimum', amount: usdc(42161, ARB_USDC, 23_888_407n) },
      refundTo: ACCOUNT,
    });
  });

  it('then a swap on Arbitrum into ARB reads the token and recipient but no amount', () => {
    expect(readAcrossCall(ACROSS_CALLS.usdcToArb)).toEqual({
      kind: 'deposit',
      provider: 'across',
      send: usdc(8453, BASE_USDC, 10_000_000n),
      destinationChainId: 42161,
      recipient: ACCOUNT,
      receive: { kind: 'swap', chainId: 42161, token: { address: ARB, known: false } },
      fee: undefined,
      refundTo: ACCOUNT,
      fillDeadline: 1792683695,
    });
  });
});

describe('given a call that is not to a pinned Across contract', () => {
  it('then the prod calldata to an unpinned address is not recognized', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.prod, to: ATTACKER })).toBeUndefined();
  });

  it('then the Base SpokePool address on Optimism is not recognized', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.prod, chainId: 10 })).toBeUndefined();
  });

  it('then a target that is not an address is not recognized', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.prod, to: 'across' })).toBeUndefined();
  });

  it('then a chain the table lacks is not recognized', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.prod, chainId: 999 })).toBeUndefined();
  });
});

describe('given a deposit whose tokens or chains need the pinned table', () => {
  it('then a lowercase target and a lowercase token resolve like checksummed ones', () => {
    const lower = { ...ACROSS_CALLS.prod, to: ACROSS_CALLS.prod.to.toLowerCase() };
    expect(readAcrossCall(lower)).toEqual(readAcrossCall(ACROSS_CALLS.prod));
    expect(pinnedToken(8453, BASE_USDC.toLowerCase())).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it('then USDbC on Base reads as an unknown token, never USDC', () => {
    const read = readAcrossCall(withArgs(ACROSS_CALLS.prod, (a) => (a[2] = word(USDBC))));
    expect(read).toMatchObject({
      send: { chainId: 8453, amount: 10_000_000n, token: { address: USDBC, known: false } },
    });
    expect(read).not.toMatchObject({ send: { token: { symbol: 'USDC' } } });
  });

  it('then an output token the table lacks reads as its address and raw amount, marked unknown', () => {
    const read = readAcrossCall(withArgs(ACROSS_CALLS.usdcNofee, (a) => (a[3] = word(OTHER))));
    expect(read).toMatchObject({
      receive: {
        kind: 'minimum',
        amount: { chainId: 42161, amount: 9_990_214n, token: { address: OTHER, known: false } },
      },
    });
  });

  it('then a fee in an output token the table lacks reads as that token, marked unknown', () => {
    const program = withProgram(ACROSS_CALLS.prod, (p) => {
      p.calls[0].target = OTHER;
      p.calls[1] = p.calls[2] = drain(OTHER, ACCOUNT);
    });
    const read = readAcrossCall(withArgs(program, (a) => (a[3] = word(OTHER))));
    expect(read && read.kind === 'deposit' && read.fee).toEqual({
      amount: { chainId: 42161, amount: 24_964n, token: { address: OTHER, known: false } },
      recipient: FEE_RECIPIENT,
      jaw: true,
    });
  });

  it('then a wrapped native output token with an empty message reads WETH, not ETH', () => {
    const read = readAcrossCall(withArgs(ACROSS_CALLS.usdcNofee, (a) => (a[3] = word(ARB_WETH))));
    expect(read).toMatchObject({ recipient: ACCOUNT, receive: { kind: 'minimum', amount: weth(42161, 9_990_214n) } });
  });

  it('then a deposit from BNB Chain reads its USDC with 18 decimals', () => {
    const call = withArgs({ ...ACROSS_CALLS.usdcNofee, chainId: 56, to: BSC_POOL }, (a) => {
      a[2] = word(BSC_USDC);
      a[4] = 10n ** 19n;
    });
    expect(readAcrossCall(call)).toMatchObject({
      send: {
        chainId: 56,
        amount: 10n ** 19n,
        token: { address: BSC_USDC, known: true, symbol: 'USDC', decimals: 18 },
      },
    });
  });

  it('then a deposit to BNB Chain reads the output with 18 decimals there', () => {
    const call = withArgs(ACROSS_CALLS.usdcNofee, (a) => {
      a[3] = word(BSC_USDC);
      a[6] = 56n;
    });
    expect(readAcrossCall(call)).toMatchObject({
      destinationChainId: 56,
      receive: {
        kind: 'minimum',
        amount: {
          chainId: 56,
          amount: 9_990_214n,
          token: { address: BSC_USDC, known: true, symbol: 'USDC', decimals: 18 },
        },
      },
    });
  });

  it('then a destination the table lacks, or one with no Across contracts, is unreadable', () => {
    expect(readAcrossCall(withArgs(ACROSS_CALLS.usdcNofee, (a) => (a[6] = 999n)))).toEqual(unreadable);
    expect(readAcrossCall(withArgs(ACROSS_CALLS.usdcNofee, (a) => (a[6] = 4663n)))).toEqual(unreadable);
  });

  it('then native ETH out to Arc, which has no pinned wrapped native, is unreadable', () => {
    const toArc = withProgram(ACROSS_CALLS.nativeEth, (p) => {
      for (const c of p.calls) c.target = c.target === HANDLER ? ARC_HANDLER : ARC_EMITTER;
    });
    const call = withArgs(toArc, (a) => {
      a[2] = word(ARC_HANDLER);
      a[7] = 5042n;
    });
    expect(readAcrossCall(call)).toEqual(unreadable);
  });
});

describe('given an Across deposit with bytes it does not explain', () => {
  it('then one byte after the tag is unreadable', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.prod, data: ACROSS_CALLS.prod.data + '00' })).toEqual(unreadable);
  });

  it('then an address argument with dirty high bytes is unreadable', () => {
    const { data } = ACROSS_CALLS.nativeEth;
    expect(readAcrossCall({ ...ACROSS_CALLS.nativeEth, data: `${data.slice(0, 10)}01${data.slice(12)}` })).toEqual(
      unreadable
    );
  });

  it('then a tag other than the Across one is unreadable', () => {
    const data = ACROSS_CALLS.prod.data.replace(/73c0de$/, '73c0df');
    expect(readAcrossCall({ ...ACROSS_CALLS.prod, data })).toEqual(unreadable);
  });

  it('then a deposit without the Across tag is unreadable', () => {
    expect(
      readAcrossCall({ ...ACROSS_CALLS.prod, data: ACROSS_CALLS.prod.data.replace(/1dc0de016173c0de$/, '') })
    ).toEqual(unreadable);
    expect(
      readAcrossCall({ ...ACROSS_CALLS.usdcNofee, data: ACROSS_CALLS.usdcNofee.data.replace(/73c0de$/, '') })
    ).toEqual(unreadable);
  });

  it('then a message to a recipient that is not the handler is unreadable', () => {
    expect(readAcrossCall(withArgs(ACROSS_CALLS.usdcFee, (a) => (a[1] = word(OTHER))))).toEqual(unreadable);
  });

  it('then calldata cut short is unreadable', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.prod, data: ACROSS_CALLS.prod.data.slice(0, 300) })).toEqual(unreadable);
  });

  it('then a zero output token, which leaves the token to the relayer, is unreadable', () => {
    expect(readAcrossCall(withArgs(ACROSS_CALLS.usdcNofee, (a) => (a[3] = word(zeroAddress))))).toEqual(unreadable);
  });

  it('then a non EVM recipient word is unreadable', () => {
    const call = withArgs(ACROSS_CALLS.usdcNofee, (a) => (a[1] = `0x01${(a[1] as string).slice(4)}`));
    expect(readAcrossCall(call)).toEqual(unreadable);
  });
});

describe('given a message program that moves funds elsewhere', () => {
  it('then a second drain to another address is unreadable', () => {
    const call = withProgram(ACROSS_CALLS.prod, (p) => (p.calls[2] = drain(ARB_USDC, ATTACKER)));
    expect(readAcrossCall(call)).toEqual(unreadable);
  });

  it('then an extra transfer is unreadable', () => {
    const call = withProgram(ACROSS_CALLS.prod, (p) => p.calls.splice(1, 0, transfer(ARB_USDC, ATTACKER, 1n)));
    expect(readAcrossCall(call)).toEqual(unreadable);
  });

  it('then an extra value call is unreadable', () => {
    const call = withProgram(ACROSS_CALLS.nativeFee, (p) =>
      p.calls.splice(2, 0, { target: ATTACKER, callData: '0x', value: 1n })
    );
    expect(readAcrossCall(call)).toEqual(unreadable);
  });

  it('then a nonzero fallback recipient is unreadable', () => {
    expect(readAcrossCall(withProgram(ACROSS_CALLS.prod, (p) => (p.fallbackRecipient = ATTACKER)))).toEqual(unreadable);
  });

  it('then an empty message to the MulticallHandler is unreadable', () => {
    const call = withArgs(ACROSS_CALLS.usdcNofee, (a) => (a[1] = word(HANDLER)));
    expect(readAcrossCall(call)).toEqual(unreadable);
  });

  it('then a program with only a drain to the user reads with no fee', () => {
    const call = withProgram(ACROSS_CALLS.prod, (p) => (p.calls = [drain(ARB_USDC, ACCOUNT)]));
    expect(readAcrossCall(call)).toMatchObject({
      recipient: ACCOUNT,
      fee: undefined,
      receive: { amount: { amount: 9_985_864n } },
    });
  });

  it('then a fee to an address JAW does not know reads that address, without the JAW label', () => {
    const call = withProgram(ACROSS_CALLS.prod, (p) => (p.calls[0] = transfer(ARB_USDC, ATTACKER, 24_964n)));
    expect(readAcrossCall(call)).toMatchObject({ fee: { recipient: ATTACKER, jaw: false } });
  });

  it('then a native fee to an address JAW does not know reads that address, without the JAW label', () => {
    const call = withProgram(ACROSS_CALLS.nativeFee, (p) => (p.calls[1].target = ATTACKER));
    expect(readAcrossCall(call)).toMatchObject({ fee: { recipient: ATTACKER, jaw: false } });
  });

  it('then a fee larger than the output is unreadable', () => {
    const call = withProgram(ACROSS_CALLS.prod, (p) => (p.calls[0] = transfer(ARB_USDC, FEE_RECIPIENT, 10n ** 12n)));
    expect(readAcrossCall(call)).toEqual(unreadable);
  });

  it('then an approve in place of the fee transfer is unreadable', () => {
    const callData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FEE_RECIPIENT, 24_964n] });
    const call = withProgram(ACROSS_CALLS.prod, (p) => (p.calls[0].callData = callData));
    expect(readAcrossCall(call)).toEqual(unreadable);
  });

  it.each([0, 1, 3])('then a byte after the arguments of program call %i is unreadable', (i) => {
    const call = withProgram(ACROSS_CALLS.prod, (p) => (p.calls[i].callData = `${p.calls[i].callData}00`));
    expect(readAcrossCall(call)).toEqual(unreadable);
  });

  it('then a third emitData is unreadable', () => {
    const call = withProgram(ACROSS_CALLS.prod, (p) => p.calls.push(p.calls[3], p.calls[3]));
    expect(readAcrossCall(call)).toEqual(unreadable);
  });

  it('then a message with bytes after the program is unreadable', () => {
    const call = withArgs(ACROSS_CALLS.prod, (a) => (a[11] = `${a[11] as string}${'00'.repeat(32)}`));
    expect(readAcrossCall(call)).toEqual(unreadable);
  });
});

describe('given a periphery depositNative or deposit value that does not fit', () => {
  it('then a spokePool argument off the table is unreadable', () => {
    expect(readAcrossCall(withArgs(ACROSS_CALLS.nativeEth, (a) => (a[0] = ATTACKER)))).toEqual(unreadable);
  });

  it('then a value other than the input amount is unreadable', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.nativeEth, value: '1' })).toEqual(unreadable);
  });

  it('then a value on an ERC-20 deposit is unreadable', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.prod, value: '1' })).toEqual(unreadable);
  });

  it('then a hex value equal to the decimal one reads the same', () => {
    const hex = { ...ACROSS_CALLS.nativeEth, value: '0x2386f26fc10000' };
    expect(readAcrossCall(hex)).toEqual(readAcrossCall(ACROSS_CALLS.nativeEth));
  });

  it('then a depositNative sent to the SpokePool is unreadable', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.nativeEth, to: ACROSS_CALLS.prod.to })).toEqual(unreadable);
  });

  it('then a native deposit from BNB Chain reads BNB, not ETH', () => {
    const call = withArgs({ ...ACROSS_CALLS.nativeEth, chainId: 56 }, (a) => {
      a[0] = BSC_POOL;
      a[3] = getAddress('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
    });
    expect(readAcrossCall(call)).toMatchObject({
      send: { chainId: 56, token: { address: zeroAddress, known: true, symbol: 'BNB', decimals: 18 } },
    });
  });

  it('then a deposit selector sent to the periphery is unreadable', () => {
    const to = ACROSS_CALLS.nativeEth.to;
    expect(readAcrossCall({ ...ACROSS_CALLS.prod, to })).toEqual(unreadable);
  });
});

describe('given one field of a recognized deposit changed', () => {
  // These fields cannot move funds, so they stay in the raw details.
  const NOT_SHOWN = new Set(['exclusiveRelayer', 'quoteTimestamp', 'exclusivityParameter', 'emitData payload']);
  const changes = (base: BridgeCall, changed: BridgeCall) => {
    const before = readAcrossCall(base);
    const after = readAcrossCall(changed);
    expect(before).toMatchObject({ kind: 'deposit' });
    return (
      after === undefined || after.kind === 'unreadable' || JSON.stringify(after, big) !== JSON.stringify(before, big)
    );
  };
  const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
  const arg = (i: number, value: unknown) => (a: unknown[]) => void (a[i] = value);

  const deposit: [string, (a: unknown[]) => void][] = [
    ['depositor', arg(0, word(OTHER))],
    ['recipient', arg(1, word(OTHER))],
    ['inputToken', arg(2, word(USDBC))],
    ['outputToken', arg(3, word(OTHER))],
    ['inputAmount', arg(4, 1n)],
    ['outputAmount', arg(5, 1n)],
    ['destinationChainId', arg(6, 10n)],
    ['exclusiveRelayer', arg(7, word(OTHER))],
    ['quoteTimestamp', arg(8, 1)],
    ['fillDeadline', arg(9, 1)],
    ['exclusivityParameter', arg(10, 99)],
    ['message', arg(11, '0x')],
  ];
  it.each(deposit)('then SpokePool.deposit %s is shown or unreadable', (name, edit) => {
    const call = withArgs(ACROSS_CALLS.prod, edit);
    expect(changes(ACROSS_CALLS.prod, call)).toBe(!NOT_SHOWN.has(name));
  });

  const native: [string, (a: unknown[]) => void][] = [
    ['spokePool', arg(0, OTHER)],
    ['depositor', arg(1, OTHER)],
    ['recipient', arg(2, word(OTHER))],
    ['inputToken', arg(3, OTHER)],
    ['inputAmount', arg(4, 1n)],
    ['outputToken', arg(5, word(OTHER))],
    ['outputAmount', arg(6, 1n)],
    ['destinationChainId', arg(7, 10n)],
    ['exclusiveRelayer', arg(8, word(OTHER))],
    ['quoteTimestamp', arg(9, 1)],
    ['fillDeadline', arg(10, 1)],
    ['exclusivityParameter', arg(11, 99)],
    ['message', arg(12, '0x')],
  ];
  it.each(native)('then periphery depositNative %s is shown or unreadable', (name, edit) => {
    const call = withArgs(ACROSS_CALLS.nativeFee, edit);
    expect(changes(ACROSS_CALLS.nativeFee, call)).toBe(!NOT_SHOWN.has(name));
  });

  it('then the call value and chain are shown or unreadable', () => {
    expect(changes(ACROSS_CALLS.nativeFee, { ...ACROSS_CALLS.nativeFee, value: '1' })).toBe(true);
    expect(changes(ACROSS_CALLS.prod, { ...ACROSS_CALLS.prod, chainId: 130 })).toBe(true);
  });

  type Slot = [string, (p: Program) => void];
  const setTarget = (i: number, to: string) => (p: Program) => void (p.calls[i].target = getAddress(to));
  const setValue = (i: number, value: bigint) => (p: Program) => void (p.calls[i].value = value);
  const setData = (i: number, data: Hex) => (p: Program) => void (p.calls[i].callData = data);
  const emitPayload = (i: number) => (p: Program) => {
    const { args } = decodeFunctionData({
      abi: parseAbi(['function emitData(bytes data)']),
      data: p.calls[i].callData,
    });
    const callData = encodeFunctionData({
      abi: parseAbi(['function emitData(bytes data)']),
      functionName: 'emitData',
      args: [`${args[0]}00` as Hex],
    });
    p.calls[i].callData = callData;
  };
  const fee = (to: string, amount: bigint) => transfer(ARB_USDC, to, amount).callData;

  const programB: Slot[] = [
    ['transfer target', setTarget(0, OTHER)],
    ['transfer recipient', setData(0, fee(ATTACKER, 24_964n))],
    ['transfer amount', setData(0, fee(FEE_RECIPIENT, 1n))],
    ['transfer value', setValue(0, 1n)],
    ['first drain target', setTarget(1, OTHER)],
    ['first drain token', setData(1, drain(OTHER, ACCOUNT).callData)],
    ['first drain destination', setData(1, drain(ARB_USDC, OTHER).callData)],
    ['both drain destinations', (p) => (p.calls[1] = p.calls[2] = drain(ARB_USDC, OTHER))],
    ['first drain value', setValue(1, 1n)],
    ['emitData target', setTarget(3, OTHER)],
    ['emitData value', setValue(3, 1n)],
    ['emitData payload', emitPayload(3)],
    ['fallbackRecipient', (p) => void (p.fallbackRecipient = OTHER)],
  ];
  it.each(programB)('then program (b) %s is shown or unreadable', (name, edit) => {
    const call = withProgram(ACROSS_CALLS.prod, edit);
    expect(changes(ACROSS_CALLS.prod, call)).toBe(!NOT_SHOWN.has(name));
  });

  const programC: Slot[] = [
    ['unwrap target', setTarget(0, OTHER)],
    ['unwrap calldata', setData(0, drain(ARB_WETH, ACCOUNT).callData)],
    ['unwrap value', setValue(0, 1n)],
    ['fee target', setTarget(1, ATTACKER)],
    ['fee calldata', setData(1, '0x00')],
    ['fee value', setValue(1, 1n)],
    ['ETH drain token', setData(2, drain(OTHER, ACCOUNT).callData)],
    ['ETH drain destination', setData(2, drain(zeroAddress, OTHER).callData)],
    ['WETH drain destination', setData(3, drain(ARB_WETH, OTHER).callData)],
    [
      'both drain destinations',
      (p) => {
        p.calls[2] = drain(zeroAddress, OTHER);
        p.calls[3] = drain(ARB_WETH, OTHER);
      },
    ],
    ['WETH drain value', setValue(3, 1n)],
    ['emitData target', setTarget(4, OTHER)],
    ['emitData payload', emitPayload(4)],
    ['fallbackRecipient', (p) => void (p.fallbackRecipient = OTHER)],
  ];
  it.each(programC)('then program (c) %s is shown or unreadable', (name, edit) => {
    const call = withProgram(ACROSS_CALLS.nativeFee, edit);
    expect(changes(ACROSS_CALLS.nativeFee, call)).toBe(!NOT_SHOWN.has(name));
  });
});

describe('given a periphery swapAndBridge, which swaps on the origin before it deposits', () => {
  const peripheryAbi = parseAbi([
    'struct Fees { uint256 amount; address recipient; }',
    'struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }',
    'struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }',
    'function swapAndBridge(SwapAndDepositData swapAndDepositData)',
  ]);
  type SwapData = Record<string, unknown> & {
    submissionFees: Record<string, unknown>;
    depositData: Record<string, unknown>;
  };

  function withSwap(call: BridgeCall, edit: (data: SwapData) => void): BridgeCall {
    const decoded = decodeFunctionData({ abi: peripheryAbi, data: call.data as Hex });
    const tail = (call.data as Hex).slice(encodeFunctionData({ abi: peripheryAbi, ...decoded }).length);
    const [data] = decoded.args;
    const copy = { ...data, submissionFees: { ...data.submissionFees }, depositData: { ...data.depositData } };
    edit(copy);
    return {
      ...call,
      data: encodeFunctionData({ abi: peripheryAbi, functionName: 'swapAndBridge', args: [copy] } as never) + tail,
    };
  }

  const changes = (base: BridgeCall, changed: BridgeCall) =>
    JSON.stringify(readAcrossCall(changed), big) !== JSON.stringify(readAcrossCall(base), big);
  const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
  const set = (key: string, value: unknown) => (d: SwapData) => void (d[key] = value);
  const setDeposit = (key: string, value: unknown) => (d: SwapData) => void (d.depositData[key] = value);

  const fields: [string, (d: SwapData) => void, boolean][] = [
    ['spokePool', set('spokePool', OTHER), true],
    ['submissionFees amount', (d) => void (d.submissionFees.amount = 1n), true],
    ['swapToken', set('swapToken', OTHER), true],
    ['swapTokenAmount', set('swapTokenAmount', 1n), true],
    ['depositor', setDeposit('depositor', OTHER), true],
    ['recipient', setDeposit('recipient', word(OTHER)), true],
    ['outputToken', setDeposit('outputToken', word(OTHER)), true],
    ['outputAmount', setDeposit('outputAmount', 1n), true],
    ['destinationChainId', setDeposit('destinationChainId', 10n), true],
    ['fillDeadline', setDeposit('fillDeadline', 1), true],
    ['message', setDeposit('message', '0x'), true],
    ['inputToken', setDeposit('inputToken', OTHER), true],
    ['minExpectedInputTokenAmount', set('minExpectedInputTokenAmount', 1n), true],
    ['submissionFees recipient', (d) => void (d.submissionFees.recipient = OTHER), false],
    ['enableProportionalAdjustment', set('enableProportionalAdjustment', false), false],
    ['nonce', set('nonce', 7n), false],
    ['exclusiveRelayer', setDeposit('exclusiveRelayer', word(OTHER)), false],
    ['quoteTimestamp', setDeposit('quoteTimestamp', 1), false],
    ['exclusivityParameter', setDeposit('exclusivityParameter', 99), false],
  ];
  it.each(fields)('then %s is shown or unreadable only if it can move funds', (_, edit, shown) => {
    expect(changes(ACROSS_CALLS.usdcToWeth, withSwap(ACROSS_CALLS.usdcToWeth, edit))).toBe(shown);
  });

  // The exchange can keep the swap and return dust; the periphery then deposits that dust.
  const poc = (d: SwapData) => {
    d.exchange = getAddress('0x000000000000000000000000000000000000dEaD');
    d.transferType = 1;
    d.minExpectedInputTokenAmount = 1n;
    d.routerCalldata = '0x';
  };

  it('then an exchange free to return 1 wei of the bridged token is unreadable', () => {
    expect(readAcrossCall(withSwap(ACROSS_CALLS.usdcToWeth, poc))).toEqual(unreadable);
    expect(readAcrossCall(withSwap(ACROSS_CALLS.ethToUsdc, poc))).toEqual(unreadable);
  });

  it('then any exchange, transfer type and router calldata read the same while the floor covers the output', () => {
    const edit = (d: SwapData) => {
      d.exchange = OTHER;
      d.transferType = 1;
      d.routerCalldata = '0x';
    };
    for (const call of [ACROSS_CALLS.usdcToWeth, ACROSS_CALLS.ethToUsdc]) {
      expect(readAcrossCall(call)).toMatchObject({ kind: 'deposit' });
      expect(changes(call, withSwap(call, edit))).toBe(false);
    }
  });

  it('then a floor equal to the output reads, and one unit below is unreadable', () => {
    const floor = (amount: bigint) => withSwap(ACROSS_CALLS.ethToUsdc, set('minExpectedInputTokenAmount', amount));
    expect(readAcrossCall(floor(23_888_407n))).toMatchObject({ kind: 'deposit' });
    expect(readAcrossCall(floor(23_888_406n))).toEqual(unreadable);
  });

  it('then the floor and the output compare across decimals, USDC with 6 on Base and 18 on BSC', () => {
    const toBsc = (outputAmount: bigint) =>
      withSwap(ACROSS_CALLS.ethToUsdc, (d) => {
        Object.assign(d.depositData, {
          destinationChainId: 56n,
          outputToken: word(BSC_USDC),
          outputAmount,
          recipient: word(ACCOUNT),
          message: '0x',
        });
      });
    expect(readAcrossCall(toBsc(23_904_714n * 10n ** 12n))).toMatchObject({
      receive: { kind: 'minimum', amount: { amount: 23_904_714n * 10n ** 12n } },
    });
    expect(readAcrossCall(toBsc(23_904_714n * 10n ** 12n + 1n))).toEqual(unreadable);
  });

  it('then an output token that is not the bridged asset is unreadable, since the floor cannot be compared', () => {
    const withOutput = (outputToken: string) =>
      withSwap(ACROSS_CALLS.ethToUsdc, (d) => {
        Object.assign(d.depositData, {
          outputToken: word(outputToken),
          outputAmount: 1n,
          recipient: word(ACCOUNT),
          message: '0x',
        });
      });
    expect(readAcrossCall(withOutput(ARB_USDC))).toMatchObject({ kind: 'deposit' });
    expect(readAcrossCall(withOutput(ARB_WETH))).toEqual(unreadable);
  });

  it('then the swap amount is what the account approves and sends, not the bridged amount', () => {
    expect(readAcrossCall(withSwap(ACROSS_CALLS.usdcToWeth, set('swapTokenAmount', 5_000_000n)))).toMatchObject({
      send: usdc(8453, BASE_USDC, 5_000_000n),
    });
  });

  it('then a value that is not the swap amount, or a value on an ERC-20 swap, is unreadable', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.ethToUsdc, value: '1' })).toEqual(unreadable);
    expect(readAcrossCall({ ...ACROSS_CALLS.usdcToWeth, value: '10000000' })).toEqual(unreadable);
  });

  it('then a bridged token not pinned on the origin is unreadable, since the exchange could fake the swap', () => {
    expect(readAcrossCall(withSwap(ACROSS_CALLS.usdcToWeth, setDeposit('inputToken', OTHER)))).toEqual(unreadable);
    expect(readAcrossCall(withSwap(ACROSS_CALLS.ethToUsdc, setDeposit('inputToken', USDBC)))).toEqual(unreadable);
  });

  it('then a value with a swap token other than WETH is unreadable', () => {
    expect(readAcrossCall(withSwap(ACROSS_CALLS.ethToUsdc, set('swapToken', BASE_USDC)))).toEqual(unreadable);
  });

  it('then swapAndBridge sent to the SpokePool is unreadable', () => {
    expect(readAcrossCall({ ...ACROSS_CALLS.usdcToWeth, to: ACROSS_CALLS.prod.to })).toEqual(unreadable);
  });

  it('then one byte after the tag is unreadable', () => {
    const call = { ...ACROSS_CALLS.usdcToWeth, data: ACROSS_CALLS.usdcToWeth.data + '00' };
    expect(readAcrossCall(call)).toEqual(unreadable);
  });
});

describe('given a destination swap through a router in the handler program', () => {
  const swapRead = { kind: 'swap', chainId: 42161, token: { address: ARB, known: false } };

  it('then the bridged token left over may go back to the recipient or stay, and still reads', () => {
    const call = withProgram(ACROSS_CALLS.usdcToArb, (p) => p.calls.splice(3, 1));
    expect(readAcrossCall(call)).toMatchObject({ recipient: ACCOUNT, receive: swapRead });
  });

  it('then a zero fallback recipient reads the same', () => {
    const call = withProgram(ACROSS_CALLS.usdcToArb, (p) => (p.fallbackRecipient = zeroAddress));
    expect(readAcrossCall(call)).toMatchObject({ receive: swapRead });
  });

  it('then the bought token sent to another address names that address as the recipient', () => {
    const call = withProgram(ACROSS_CALLS.usdcToArb, (p) => {
      p.calls[2] = drain(ARB, OTHER);
      p.calls[3] = drain(ARB_USDC, OTHER);
      p.fallbackRecipient = OTHER;
    });
    expect(readAcrossCall(call)).toMatchObject({ recipient: OTHER, receive: swapRead });
  });

  const mutants: [string, (p: Program) => void][] = [
    ['a fallback recipient other than the recipient', (p) => void (p.fallbackRecipient = ATTACKER)],
    ['the left over bridged token sent elsewhere', (p) => void (p.calls[3] = drain(ARB_USDC, ATTACKER))],
    ['a router call with value', (p) => void (p.calls[1].value = 1n)],
    ['a router call that is not execute', (p) => void (p.calls[1].callData = transfer(ARB, ATTACKER, 1n).callData)],
    ['a router call to another address than the drain', (p) => void (p.calls[1].target = ATTACKER)],
    ['the bridged token drained as the bought one', (p) => void (p.calls[2] = drain(ARB_USDC, ACCOUNT))],
    ['an extra call', (p) => p.calls.splice(4, 0, transfer(ARB, ATTACKER, 1n))],
    ['no router call', (p) => p.calls.splice(1, 1)],
  ];
  it.each(mutants)('then %s is unreadable', (_, edit) => {
    expect(readAcrossCall(withProgram(ACROSS_CALLS.usdcToArb, edit))).toEqual(unreadable);
  });

  it('then any router reads, as long as the bridged token is drained to it', () => {
    const call = withProgram(ACROSS_CALLS.usdcToArb, (p) => {
      p.calls[0] = drain(ARB_USDC, OTHER);
      p.calls[1].target = OTHER;
    });
    expect(readAcrossCall(call)).toMatchObject({ receive: swapRead });
  });
});

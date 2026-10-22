import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  pad,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { ALLOWLIST, APP_FEE, type AcrossContracts } from '../allowlist';
import type { BackendQuote, CheckCode, CheckResult, QuoteRequest, SwapCall } from '../check';
import { clearsFloor, sameAsset } from './assets';

const depositAbi = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
  'function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
]);
const handlerAbi = parseAbi([
  'function drainLeftoverTokens(address token, address destination)',
  'function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)',
]);
const withdrawAll = encodeFunctionData({
  abi: parseAbi(['function withdraw(uint256 wad)']),
  functionName: 'withdraw',
  args: [0n],
});
const emitterAbi = parseAbi(['function emitData(bytes data)']);
const instructionsAbi = parseAbiParameters(
  '((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)'
);
const metadataAbi = parseAbiParameters(
  'uint8, uint8, uint8, address, uint256, uint256, uint256, uint256, string, uint256, bool, address, address'
);

type Call = { target: Address; callData: Hex; value: bigint };
type Instructions = { calls: readonly Call[]; fallbackRecipient: Address };

const DEPOSIT = '0xad5425c6';
const DEPOSIT_NATIVE = '0x609ea081';
const SWAP_AND_BRIDGE = '0x110560ad';
const MAX_FILL_SECONDS = 21_600;
const FILL_MARGIN_SECONDS = 600;
// SpokePool.depositQuoteTimeBuffer on Base and Base Sepolia: older quoteTimestamps revert the deposit.
const QUOTE_TIME_BUFFER_SECONDS = 3600;
const QUOTE_TIME_MARGIN_SECONDS = 300;
const MAX_EXCLUSIVITY_SECONDS = 60;
const quoteIdPattern = /^across:[A-Za-z0-9-]{1,64}$/;
const baseUnits = /^[1-9][0-9]*$/;
// Across appends an optional integrator tag and its own tag after the ABI payload.
const tagSuffix = /^(1dc0de[0-9a-f]{4})?73c0de$/;

// One letter per message call; each program regex is the accepted letter sequence.
const kind = {
  feeTransfer: 'F',
  drain: 'D',
  emitData: 'E',
  unwrap: 'U',
  valueFee: 'V',
  drainEth: 'N',
  drainWeth: 'W',
  other: 'X',
} as const;
const unwrapProgram = new RegExp(
  `^${kind.unwrap}${kind.valueFee}?${kind.drainEth}${kind.drainWeth}${kind.emitData}{0,2}$`
);

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (address: string) => pad(address.toLowerCase() as Hex, { size: 32 });

export function checkAcross(
  request: QuoteRequest,
  quote: BackendQuote,
  now: number,
  ownerWindowSec: number
): CheckResult {
  const fail = (code: CheckCode) => ({ ok: false as const, code });

  if (!quoteIdPattern.test(quote.quoteId) || quote.deposit !== undefined) return fail('quote_id');
  if (!isAddress(request.destinationToken, { strict: false }) || !isAddress(request.recipient, { strict: false })) {
    return fail('quote_id');
  }

  if (!baseUnits.test(request.amount) || quote.inputAmount !== request.amount) return fail('input_amount');
  const { expectedOutputAmount, minOutputAmount } = quote;
  if (!baseUnits.test(expectedOutputAmount) || !baseUnits.test(minOutputAmount)) return fail('output_amount');
  const min = BigInt(minOutputAmount);
  if (min > BigInt(expectedOutputAmount)) return fail('output_amount');

  const origin = ALLOWLIST[request.originChainId];
  const destination = ALLOWLIST[request.destinationChainId];
  if (!origin?.across) return fail('unsupported_chain');
  if (!destination?.across || origin.testnet !== destination.testnet) return fail('destination_chain');
  const pair = sameAsset(request);
  if (!pair) return fail('route_unsupported');
  if (!clearsFloor(request, min, pair)) return fail('output_floor');

  const nativeIn = isAddressEqual(request.originToken, zeroAddress);
  const nativeOut = isAddressEqual(request.destinationToken as Address, zeroAddress);
  const txs = quote.transactions;
  if (txs.some((tx) => tx.chainId !== request.originChainId)) return fail('tx_chain');
  if (txs.length < 1 || txs.length > (nativeIn ? 1 : 2)) return fail('tx_count');
  const deposit = txs[txs.length - 1];
  const selector = deposit.data.slice(0, 10).toLowerCase();
  if (selector === SWAP_AND_BRIDGE) return fail('route_unsupported');
  if (selector !== (nativeIn ? DEPOSIT_NATIVE : DEPOSIT)) return fail('tx_selector');
  const pool = origin.across.spokePool;
  const target = nativeIn ? origin.across.periphery : pool;
  const value = nativeIn ? request.amount : '0';
  if (txs.length === 2 && !approves(txs[0], request.originToken, pool)) return fail('approve_spender');
  if (!sameHex(deposit.to, target)) return fail('tx_to');
  if (deposit.value !== value) return fail('tx_value');
  const decoded = depositArgs(deposit.data);
  if (!decoded) return fail('tx_data');
  if (decoded.spokePool !== undefined && !isAddressEqual(decoded.spokePool, pool)) return fail('tx_to');

  const { args } = decoded;
  const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId] = args;
  const { 7: exclusiveRelayer, 8: quoteTimestamp, 9: fillDeadline, 10: exclusivity, 11: message } = args;
  const tokenIn = nativeIn ? origin.across.wrappedNative : request.originToken;
  const tokenOut = nativeOut ? destination.across.wrappedNative : getAddress(request.destinationToken);
  if (depositor !== word(request.account)) return fail('depositor');
  if (!tokenIn || inputToken !== word(tokenIn) || inputAmount !== BigInt(request.amount)) return fail('input_amount');
  if (destinationChainId !== BigInt(request.destinationChainId)) return fail('destination_chain');
  if (!tokenOut || outputToken !== word(tokenOut)) return fail('output_token');
  const approveBy = now + ownerWindowSec;
  if (fillDeadline < approveBy + FILL_MARGIN_SECONDS || fillDeadline > now + MAX_FILL_SECONDS) return fail('deadline');
  if (quoteTimestamp > now) return fail('deadline');
  if (quoteTimestamp + QUOTE_TIME_BUFFER_SECONDS < approveBy + QUOTE_TIME_MARGIN_SECONDS) return fail('deadline');
  if (exclusivity > MAX_EXCLUSIVITY_SECONDS) return fail('exclusivity');
  if (exclusivity === 0 && exclusiveRelayer !== zeroHash) return fail('exclusivity');

  let fee = 0n;
  if (message === '0x') {
    if (nativeOut) return fail('message_program');
    if (recipient !== word(request.recipient)) return fail('recipient');
  } else {
    const handler = destination.across.multicallHandler;
    if (recipient !== word(handler)) return fail('recipient');
    const program = instructions(message);
    if (!program) return fail('message_program');
    if (isDestinationSwap(program.calls, request, handler)) return fail('route_unsupported');
    if (!isAddressEqual(program.fallbackRecipient, zeroAddress)) return fail('message_program');
    const programFee = nativeOut
      ? unwrapFeeOf(program.calls, tokenOut, request.recipient, destination.across)
      : feeOf(program.calls, tokenOut, request.recipient, destination.across);
    if (programFee === undefined) return fail('message_program');
    fee = programFee;
  }
  if (outputAmount - fee !== min) return fail('output_amount');
  if (fee * 10_000n > outputAmount * APP_FEE.maxBps) return fail('app_fee');

  const depositCall: SwapCall = {
    kind: 'deposit',
    chainId: request.originChainId,
    to: target,
    data: deposit.data as Hex,
    value,
  };
  const approve: SwapCall = {
    kind: 'approve',
    chainId: request.originChainId,
    to: getAddress(request.originToken),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, BigInt(request.amount)] }),
    value: '0',
  };
  const feesUsd = quote.fees.totalUsd;
  return {
    ok: true,
    quoteId: quote.quoteId,
    calls: nativeIn ? [depositCall] : [approve, depositCall],
    quote: {
      provider: 'across',
      inputAmount: quote.inputAmount,
      expectedOutputAmount,
      minOutputAmount,
      expectedFillTimeSec: quote.expectedFillTimeSec,
      ...(feesUsd !== undefined ? { feesUsd } : {}),
      deadline: fillDeadline,
      appFee: fee.toString(),
    },
  };
}

function approves(tx: { to: string; data: string }, token: Address, spender: Address): boolean {
  if (!sameHex(tx.to, token)) return false;
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex });
    return functionName === 'approve' && isAddressEqual(args[0], spender);
  } catch {
    return false;
  }
}

function depositArgs(data: string) {
  try {
    const decoded = decodeFunctionData({ abi: depositAbi, data: data as Hex });
    const lower = data.toLowerCase();
    const payload = encodeFunctionData({ abi: depositAbi, ...decoded });
    if (!lower.startsWith(payload) || !tagSuffix.test(lower.slice(payload.length))) return undefined;
    if (decoded.functionName === 'deposit') return { spokePool: undefined, args: decoded.args };
    const [spokePool, depositor, recipient, inputToken, inputAmount, outputToken, ...rest] = decoded.args;
    return {
      spokePool,
      args: [word(depositor), recipient, word(inputToken), outputToken, inputAmount, ...rest] as const,
    };
  } catch {
    return undefined;
  }
}

function instructions(message: Hex): Instructions | undefined {
  try {
    const [decoded] = decodeAbiParameters(instructionsAbi, message);
    return sameHex(encodeAbiParameters(instructionsAbi, [decoded]), message) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

const drainOf = (token: Address, recipient: string) =>
  encodeFunctionData({ abi: handlerAbi, functionName: 'drainLeftoverTokens', args: [token, getAddress(recipient)] });

function feeOf(calls: readonly Call[], token: Address, recipient: string, across: AcrossContracts) {
  const [transfer, ...rest] = calls;
  if (!transfer || transfer.value !== 0n || !isAddressEqual(transfer.target, token)) return undefined;

  const drain = { target: across.multicallHandler, callData: drainOf(token, recipient) };
  const expected = [drain, drain];
  if (across.eventEmitter) {
    const metadata = [1, 0, 1, token, 0n, 0n, 0n, 0n, 'none', 0n, true, getAddress(recipient), APP_FEE.recipient] as const;
    const data = encodeAbiParameters(metadataAbi, metadata);
    const callData = encodeFunctionData({ abi: emitterAbi, functionName: 'emitData', args: [data] });
    expected.push({ target: across.eventEmitter, callData });
  }
  if (rest.length !== expected.length) return undefined;
  const exact = rest.every(
    (call, i) =>
      call.value === 0n &&
      isAddressEqual(call.target, expected[i].target) &&
      sameHex(call.callData, expected[i].callData)
  );
  return exact ? feeTransfer(transfer.callData) : undefined;
}

function unwrapFeeOf(calls: readonly Call[], weth: Address, recipient: string, across: AcrossContracts) {
  const unwrap = encodeFunctionData({
    abi: handlerAbi,
    functionName: 'makeCallWithBalance',
    args: [weth, withdrawAll, 0n, [{ token: weth, offset: 4n }]],
  });
  const drainEth = drainOf(zeroAddress, recipient);
  const drainWeth = drainOf(weth, recipient);
  const kindOf = (call: Call) => {
    if (isAddressEqual(call.target, APP_FEE.recipient) && call.callData === '0x') return kind.valueFee;
    if (isAddressEqual(call.target, across.multicallHandler)) {
      if (sameHex(call.callData, unwrap)) return kind.unwrap;
      if (sameHex(call.callData, drainEth)) return kind.drainEth;
      if (sameHex(call.callData, drainWeth)) return kind.drainWeth;
    }
    return emits(call, across) ? kind.emitData : kind.other;
  };
  let fee = 0n;
  const kinds = calls.map((call) => {
    const k = kindOf(call);
    if (k === kind.valueFee) fee = call.value;
    else if (call.value !== 0n) return kind.other;
    return k;
  });
  return unwrapProgram.test(kinds.join('')) ? fee : undefined;
}

const emits = (call: Call, across: AcrossContracts) =>
  across.eventEmitter !== undefined && isAddressEqual(call.target, across.eventEmitter) && isEmit(call.callData);

function feeTransfer(data: Hex): bigint | undefined {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName !== 'transfer' || !isAddressEqual(decoded.args[0], APP_FEE.recipient)) return undefined;
    return sameHex(encodeFunctionData({ abi: erc20Abi, ...decoded }), data) ? decoded.args[1] : undefined;
  } catch {
    return undefined;
  }
}

function isEmit(data: Hex): boolean {
  try {
    const { args } = decodeFunctionData({ abi: emitterAbi, data });
    return sameHex(encodeFunctionData({ abi: emitterAbi, functionName: 'emitData', args }), data);
  } catch {
    return false;
  }
}

function isDestinationSwap(calls: readonly Call[], request: QuoteRequest, handler: Address): boolean {
  const [first, second] = calls;
  if (!first || !second || !isAddressEqual(first.target, handler)) return false;
  const drain = drainArgs(first.callData);
  if (!drain) return false;
  const [token, to] = drain;
  return sameHex(token, request.destinationToken) && isAddressEqual(second.target, to);
}

function drainArgs(data: Hex) {
  try {
    const decoded = decodeFunctionData({ abi: handlerAbi, data });
    return decoded.functionName === 'drainLeftoverTokens' ? decoded.args : undefined;
  } catch {
    return undefined;
  }
}

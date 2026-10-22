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
  type Address,
  type Hex,
} from 'viem';
import { ALLOWLIST, APP_FEE, type AcrossContracts } from '../allowlist';
import type { BackendQuote, CheckCode, CheckResult, QuoteRequest, SwapCall } from '../check';
import { clearsFloor, sameAsset } from './assets';

const spokePoolAbi = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
]);
const handlerAbi = parseAbi(['function drainLeftoverTokens(address token, address destination)']);
const emitterAbi = parseAbi(['function emitData(bytes data)']);
const instructionsAbi = parseAbiParameters(
  '((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)'
);

type Call = { target: Address; callData: Hex; value: bigint };
type Instructions = { calls: readonly Call[]; fallbackRecipient: Address };

const DEPOSIT = '0xad5425c6';
const SWAP_AND_BRIDGE = '0x110560ad';
const MAX_FILL_SECONDS = 21_600;
const MAX_EXCLUSIVITY_SECONDS = 60;
const quoteIdPattern = /^across:[A-Za-z0-9-]{1,64}$/;
const baseUnits = /^[1-9][0-9]*$/;
// Across appends an optional integrator tag and its own tag after the ABI payload.
const tagSuffix = /^(1dc0de[0-9a-f]{4})?73c0de$/;

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (address: string) => pad(address.toLowerCase() as Hex, { size: 32 });

export function checkAcross(request: QuoteRequest, quote: BackendQuote, now: number): CheckResult {
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

  const txs = quote.transactions;
  if (txs.some((tx) => tx.chainId !== request.originChainId)) return fail('tx_chain');
  if (txs.length < 1 || txs.length > 2) return fail('tx_count');
  const deposit = txs[txs.length - 1];
  const selector = deposit.data.slice(0, 10).toLowerCase();
  if (selector === SWAP_AND_BRIDGE) return fail('route_unsupported');
  if (selector !== DEPOSIT || isAddressEqual(request.originToken, zeroAddress)) return fail('tx_selector');
  const pool = origin.across.spokePool;
  if (txs.length === 2 && !approves(txs[0], request.originToken, pool)) return fail('approve_spender');
  if (!sameHex(deposit.to, pool)) return fail('tx_to');
  if (deposit.value !== '0') return fail('tx_value');
  const args = depositArgs(deposit.data);
  if (!args) return fail('tx_data');

  const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId] = args;
  const { 9: fillDeadline, 10: exclusivity, 11: message } = args;
  if (depositor !== word(request.account)) return fail('depositor');
  if (inputToken !== word(request.originToken) || inputAmount !== BigInt(request.amount)) return fail('input_amount');
  if (destinationChainId !== BigInt(request.destinationChainId)) return fail('destination_chain');
  if (isAddressEqual(request.destinationToken as Address, zeroAddress)) return fail('output_token');
  if (outputToken !== word(request.destinationToken)) return fail('output_token');
  if (fillDeadline <= now || fillDeadline > now + MAX_FILL_SECONDS) return fail('deadline');
  if (exclusivity > MAX_EXCLUSIVITY_SECONDS) return fail('exclusivity');

  let fee = 0n;
  if (message === '0x') {
    if (recipient !== word(request.recipient)) return fail('recipient');
  } else {
    const handler = destination.across.multicallHandler;
    if (recipient !== word(handler)) return fail('recipient');
    const program = instructions(message);
    if (!program) return fail('message_program');
    if (isDestinationSwap(program.calls, request, handler)) return fail('route_unsupported');
    const programFee = feeOf(program, request, destination.across);
    if (programFee === undefined) return fail('message_program');
    fee = programFee;
  }
  if (outputAmount - fee !== min) return fail('output_amount');
  if (fee * 10_000n > outputAmount * APP_FEE.maxBps) return fail('app_fee');

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
    provider: 'across',
    quoteId: quote.quoteId,
    calls: [
      approve,
      { kind: 'deposit', chainId: request.originChainId, to: pool, data: deposit.data as Hex, value: '0' },
    ],
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
    const { args } = decodeFunctionData({ abi: spokePoolAbi, data: data as Hex });
    const payload = encodeFunctionData({ abi: spokePoolAbi, functionName: 'deposit', args });
    const lower = data.toLowerCase();
    return lower.startsWith(payload) && tagSuffix.test(lower.slice(payload.length)) ? args : undefined;
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

function feeOf(program: Instructions, request: QuoteRequest, across: AcrossContracts): bigint | undefined {
  if (!isAddressEqual(program.fallbackRecipient, zeroAddress)) return undefined;
  const drain = encodeFunctionData({
    abi: handlerAbi,
    functionName: 'drainLeftoverTokens',
    args: [getAddress(request.destinationToken), getAddress(request.recipient)],
  });
  let fee = 0n;
  const kinds = program.calls.map((call) => {
    if (call.value !== 0n) return 'X';
    const transfer = sameHex(call.target, request.destinationToken) ? feeTransfer(call.callData) : undefined;
    if (transfer !== undefined) {
      fee = transfer;
      return 'F';
    }
    if (isAddressEqual(call.target, across.multicallHandler) && sameHex(call.callData, drain)) return 'D';
    if (across.eventEmitter && isAddressEqual(call.target, across.eventEmitter) && isEmit(call.callData)) return 'E';
    return 'X';
  });
  return /^F?D{1,2}E{0,2}$/.test(kinds.join('')) ? fee : undefined;
}

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
  try {
    const [token, to] = decodeFunctionData({ abi: handlerAbi, data: first.callData }).args;
    return sameHex(token, request.destinationToken) && isAddressEqual(second.target, to);
  } catch {
    return false;
  }
}

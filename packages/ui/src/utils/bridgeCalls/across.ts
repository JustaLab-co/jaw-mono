import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hexToBytes,
  isAddress,
  isAddressEqual,
  parseAbi,
  parseAbiParameters,
  size,
  slice,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { JAW_FEE_RECIPIENT, type AcrossContracts } from './contracts';
import type { BridgeContracts } from './table';
import {
  pinnedToken,
  tokenAmount,
  tokenOf,
  type BridgeCall,
  type Received,
  type TokenAmount,
  type Unreadable,
} from './view';

const DEPOSIT_ABI = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
  'function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
  'struct Fees { uint256 amount; address recipient; }',
  'struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }',
  'struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }',
  'function swapAndBridge(SwapAndDepositData swapAndDepositData)',
]);
const HANDLER_ABI = parseAbi([
  'function drainLeftoverTokens(address token, address destination)',
  'function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)',
]);
const EMITTER_ABI = parseAbi(['function emitData(bytes data)']);
const ROUTER_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs)',
  'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
]);
// UniversalRouter inputs for V3_SWAP_EXACT_IN (0x00) and V2_SWAP_EXACT_IN (0x08).
const V3_SWAP = parseAbiParameters(
  'address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser'
);
const V2_SWAP = parseAbiParameters(
  'address recipient, uint256 amountIn, uint256 amountOutMin, address[] path, bool payerIsUser'
);
const INSTRUCTIONS = parseAbiParameters(
  '((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)'
);
const WITHDRAW_ALL = encodeFunctionData({
  abi: parseAbi(['function withdraw(uint256 wad)']),
  functionName: 'withdraw',
  args: [0n],
});
// Across appends an optional integrator tag and its own tag after the ABI payload.
const TAG_SUFFIX = /^(1dc0de[0-9a-f]{4})?73c0de$/;
const EVM_WORD = /^0x0{24}[0-9a-f]{40}$/;

export type AcrossFee = { amount: TokenAmount; recipient: Address; jaw: boolean };

export type AcrossDeposit = {
  kind: 'deposit';
  provider: 'across';
  send: TokenAmount;
  destinationChainId: number;
  recipient: Address;
  receive: Received;
  fee?: AcrossFee;
  refundTo: Address;
  fillDeadline: number;
};

type Call = { target: Address; callData: Hex; value: bigint };
type Program = { calls: readonly Call[]; fallbackRecipient: Address };
type Fee = { recipient: Address; amount: bigint };
type Payout = { recipient: Address; received: Address; fee?: Fee; swapped?: true };
type Fields = {
  depositor: Address;
  recipient: Address;
  sendToken: Address;
  sendAmount: bigint;
  outputToken: Address;
  outputAmount: bigint;
  destinationChainId: number;
  fillDeadline: number;
  message: Hex;
};

class TableMiss extends Error {}

/** A table entry the call needs. Without it the call is unreadable, and a newer table might have it. */
function required<T>(entry: T | undefined): T {
  if (entry === undefined) throw new TableMiss();
  return entry;
}

const unreadable = (outsideTable = false): Unreadable => ({
  kind: 'unreadable',
  provider: 'across',
  ...(outsideTable && { outsideTable: true as const }),
});

/** Undefined when the call is not to a pinned Across contract; unreadable when it is and breaks a rule. */
export function readAcrossCall(contracts: BridgeContracts, call: BridgeCall): AcrossDeposit | Unreadable | undefined {
  const across = contracts.chain(call.chainId)?.across;
  if (!across || !isAddress(call.to, { strict: false })) return undefined;
  const toPool = isAddressEqual(call.to, across.spokePool);
  if (!toPool && !isAddressEqual(call.to, across.periphery)) return undefined;
  try {
    const fields = fieldsOf(contracts, call, across, toPool);
    if (!fields) return unreadable();
    const destination = contracts.chain(fields.destinationChainId)?.across;
    if (!destination) return unreadable(true);
    return depositOf(contracts, call.chainId, fields, destination) ?? unreadable();
  } catch (error) {
    return unreadable(error instanceof TableMiss);
  }
}

function fieldsOf(
  contracts: BridgeContracts,
  call: BridgeCall,
  origin: AcrossContracts,
  toPool: boolean
): Fields | undefined {
  if (!call.data) return undefined;
  const data = call.data.toLowerCase() as Hex;
  const decoded = decodeFunctionData({ abi: DEPOSIT_ABI, data });
  const payload = encodeFunctionData({ abi: DEPOSIT_ABI, ...decoded });
  if (!data.startsWith(payload) || !TAG_SUFFIX.test(data.slice(payload.length))) return undefined;
  const value = BigInt(call.value ?? 0);

  if (decoded.functionName === 'deposit') {
    if (!toPool || value !== 0n) return undefined;
    const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId] = decoded.args;
    const { 9: fillDeadline, 11: message } = decoded.args;
    return {
      depositor: addressOf(depositor),
      recipient: addressOf(recipient),
      sendToken: tokenWord(inputToken),
      sendAmount: inputAmount,
      outputToken: tokenWord(outputToken),
      outputAmount,
      destinationChainId: Number(destinationChainId),
      fillDeadline,
      message,
    };
  }
  if (toPool) return undefined;

  if (decoded.functionName === 'depositNative') {
    const [spokePool, depositor, recipient, inputToken, inputAmount, outputToken, outputAmount, destinationChainId] =
      decoded.args;
    const { 10: fillDeadline, 12: message } = decoded.args;
    if (!isAddressEqual(spokePool, origin.spokePool) || value !== inputAmount) return undefined;
    if (!isAddressEqual(inputToken, required(origin.wrappedNative))) return undefined;
    return {
      depositor: getAddress(depositor),
      recipient: addressOf(recipient),
      sendToken: zeroAddress,
      sendAmount: inputAmount,
      outputToken: tokenWord(outputToken),
      outputAmount,
      destinationChainId: Number(destinationChainId),
      fillDeadline,
      message,
    };
  }

  const [{ submissionFees, depositData, swapToken, swapTokenAmount, minExpectedInputTokenAmount, spokePool }] =
    decoded.args;
  if (!isAddressEqual(spokePool, origin.spokePool) || submissionFees.amount !== 0n) return undefined;
  // The periphery deposits whatever the exchange returns and only checks it against
  // minExpectedInputTokenAmount, so that floor must cover the output the screen shows.
  if (!floorCoversOutput(contracts, call.chainId, depositData, minExpectedInputTokenAmount)) return undefined;
  const native = value !== 0n;
  if (native && (value !== swapTokenAmount || !isAddressEqual(swapToken, required(origin.wrappedNative)))) {
    return undefined;
  }
  return {
    depositor: getAddress(depositData.depositor),
    recipient: addressOf(depositData.recipient),
    sendToken: native ? zeroAddress : getAddress(swapToken),
    sendAmount: swapTokenAmount,
    outputToken: tokenWord(depositData.outputToken),
    outputAmount: depositData.outputAmount,
    destinationChainId: Number(depositData.destinationChainId),
    fillDeadline: depositData.fillDeadline,
    message: depositData.message,
  };
}

type SwapDeposit = { inputToken: Address; outputToken: Hex; outputAmount: bigint; destinationChainId: bigint };

// Both tokens must be pinned as the same asset; amounts compare across their decimals.
function floorCoversOutput(contracts: BridgeContracts, chainId: number, deposit: SwapDeposit, floor: bigint): boolean {
  const input = required(pinnedToken(contracts, chainId, deposit.inputToken));
  const output = required(pinnedToken(contracts, Number(deposit.destinationChainId), tokenWord(deposit.outputToken)));
  if (input.symbol !== output.symbol) return false;
  return floor * 10n ** BigInt(output.decimals) >= deposit.outputAmount * 10n ** BigInt(input.decimals);
}

function depositOf(
  contracts: BridgeContracts,
  chainId: number,
  fields: Fields,
  destination: AcrossContracts
): AcrossDeposit | undefined {
  const { destinationChainId, outputAmount } = fields;
  const payout = payoutOf(fields, destination);
  if (!payout || (payout.fee && payout.fee.amount > outputAmount)) return undefined;

  const { fee, received } = payout;
  const receive: Received = payout.swapped
    ? { kind: 'swap', chainId: destinationChainId, token: tokenOf(contracts, destinationChainId, received) }
    : {
        kind: 'minimum',
        amount: tokenAmount(contracts, destinationChainId, received, outputAmount - (fee?.amount ?? 0n)),
      };
  return {
    kind: 'deposit',
    provider: 'across',
    send: tokenAmount(contracts, chainId, fields.sendToken, fields.sendAmount),
    destinationChainId,
    recipient: payout.recipient,
    receive,
    fee: fee && {
      amount: tokenAmount(contracts, destinationChainId, received, fee.amount),
      recipient: fee.recipient,
      jaw: isAddressEqual(fee.recipient, JAW_FEE_RECIPIENT),
    },
    refundTo: fields.depositor,
    fillDeadline: fields.fillDeadline,
  };
}

function payoutOf(
  { recipient, outputToken, outputAmount, message }: Fields,
  across: AcrossContracts
): Payout | undefined {
  const toHandler = isAddressEqual(recipient, across.multicallHandler);
  if (message === '0x') return toHandler ? undefined : { recipient, received: outputToken };
  if (!toHandler) return undefined;
  const program = programOf(message);
  if (!program) return undefined;
  return (
    unwrapPayout(program, outputToken, across) ??
    tokenPayout(program, outputToken, across) ??
    swapPayout(program, outputToken, outputAmount, across)
  );
}

function addressOf(word: Hex): Address {
  if (!EVM_WORD.test(word)) throw new Error('not an EVM address');
  return getAddress(`0x${word.slice(26)}`);
}

// A zero output token lets the relayer pick what arrives.
function tokenWord(word: Hex): Address {
  const token = addressOf(word);
  if (token === zeroAddress) throw new Error('zero token');
  return token;
}

function programOf(message: Hex): Program | undefined {
  const [program] = decodeAbiParameters(INSTRUCTIONS, message);
  return encodeAbiParameters(INSTRUCTIONS, [program]) === message ? program : undefined;
}

// [fee transfer], drain to the recipient, [second drain to the same recipient], emits.
function tokenPayout({ calls, fallbackRecipient }: Program, token: Address, across: AcrossContracts) {
  if (fallbackRecipient !== zeroAddress) return undefined;
  let i = 0;
  let fee: Fee | undefined;
  if (calls[0] && isAddressEqual(calls[0].target, token)) {
    fee = feeTransfer(calls[0]);
    if (!fee) return undefined;
    i = 1;
  }
  const recipient = drainedTo(calls[i], token, across);
  if (!recipient) return undefined;
  i += drainedTo(calls[i + 1], token, across) === recipient ? 2 : 1;
  return emitsOnly(calls.slice(i), across) ? { recipient, received: token, fee } : undefined;
}

// Unwrap all WETH, [native fee], drain ETH and the WETH left to one recipient, emits.
function unwrapPayout({ calls, fallbackRecipient }: Program, weth: Address, across: AcrossContracts) {
  if (fallbackRecipient !== zeroAddress || !across.wrappedNative || !isAddressEqual(weth, across.wrappedNative)) {
    return undefined;
  }
  const unwrap = encodeFunctionData({
    abi: HANDLER_ABI,
    functionName: 'makeCallWithBalance',
    args: [weth, WITHDRAW_ALL, 0n, [{ token: weth, offset: 4n }]],
  });
  const [first, second] = calls;
  if (!first || first.value !== 0n || first.callData !== unwrap) return undefined;
  if (!isAddressEqual(first.target, across.multicallHandler)) return undefined;

  let i = 1;
  let fee: Fee | undefined;
  if (second && second.value > 0n) {
    if (second.callData !== '0x') return undefined;
    fee = { recipient: getAddress(second.target), amount: second.value };
    i = 2;
  }
  const recipient = drainedTo(calls[i], zeroAddress, across);
  if (!recipient || drainedTo(calls[i + 1], weth, across) !== recipient) return undefined;
  return emitsOnly(calls.slice(i + 2), across) ? { recipient, received: zeroAddress, fee } : undefined;
}

// Drain to the pinned router, its `execute`, drain the bought token [and the bridged one left], emits.
// The router sets the amount, so any other router could keep the whole bridged amount.
function swapPayout({ calls, fallbackRecipient }: Program, bridged: Address, amount: bigint, across: AcrossContracts) {
  const drained = drainedTo(calls[0], bridged, across);
  if (!drained || !calls[1] || !isAddressEqual(calls[1].target, drained)) return undefined;
  const router = required(across.swapRouter);
  if (drained !== router) return undefined;
  const bought = drainOf(calls[2], across);
  if (!bought || isAddressEqual(bought.token, bridged)) return undefined;
  if (!routerSwaps(calls[1], router, { from: bridged, to: bought.token, amount }, across)) return undefined;
  const { token, destination: recipient } = bought;
  if (fallbackRecipient !== zeroAddress && !isAddressEqual(fallbackRecipient, recipient)) return undefined;
  const i = drainedTo(calls[3], bridged, across) === recipient ? 4 : 3;
  return emitsOnly(calls.slice(i), across) ? { recipient, received: token, swapped: true as const } : undefined;
}

function feeTransfer(call: Call): Fee | undefined {
  if (call.value !== 0n) return undefined;
  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.callData });
  if (decoded.functionName !== 'transfer') return undefined;
  if (encodeFunctionData({ abi: erc20Abi, ...decoded }) !== call.callData) return undefined;
  const [recipient, amount] = decoded.args;
  return { recipient: getAddress(recipient), amount };
}

function drainOf(call: Call | undefined, across: AcrossContracts) {
  if (!call || call.value !== 0n || !isAddressEqual(call.target, across.multicallHandler)) return undefined;
  const decoded = decodeFunctionData({ abi: HANDLER_ABI, data: call.callData });
  if (decoded.functionName !== 'drainLeftoverTokens') return undefined;
  if (encodeFunctionData({ abi: HANDLER_ABI, ...decoded }) !== call.callData) return undefined;
  const [token, destination] = decoded.args;
  return { token: getAddress(token), destination: getAddress(destination) };
}

function drainedTo(call: Call | undefined, token: Address, across: AcrossContracts): Address | undefined {
  const drain = drainOf(call, across);
  return drain && isAddressEqual(drain.token, token) ? drain.destination : undefined;
}

type Swap = { from: Address; to: Address; amount: bigint };

// The router pays each step to the recipient in its inputs and keeps what no step spends, where
// anyone can sweep it. So every step must swap the bridged token into the bought one and pay the
// handler, and the steps must spend the whole bridged amount. Any other command is unreadable.
// Uniswap appends a tag after the arguments, so trailing bytes are allowed.
function routerSwaps(call: Call | undefined, router: Address, swap: Swap, across: AcrossContracts): boolean {
  if (!call || call.value !== 0n || !isAddressEqual(call.target, router)) return false;
  const [commands, inputs] = decodeFunctionData({ abi: ROUTER_ABI, data: call.callData }).args;
  const steps = [...hexToBytes(commands)];
  if (steps.length === 0 || steps.length !== inputs.length) return false;
  let spent = 0n;
  for (const [i, command] of steps.entries()) {
    const step = swapStep(command, inputs[i]);
    if (!step || !isAddressEqual(step.recipient, across.multicallHandler)) return false;
    if (!isAddressEqual(step.from, swap.from) || !isAddressEqual(step.to, swap.to)) return false;
    spent += step.amountIn;
  }
  return spent === swap.amount;
}

// Inputs are read by offset, as the router reads them, so arguments after these five, which some
// routers take, are allowed. A V3 path is a token and then a 3-byte fee and a token per pool.
function swapStep(command: number, input: Hex) {
  if (command === 0x00) {
    const [recipient, amountIn, , path, payerIsUser] = decodeAbiParameters(V3_SWAP, input);
    if (payerIsUser || size(path) < 43 || (size(path) - 20) % 23 !== 0) return undefined;
    return { recipient, amountIn, from: getAddress(slice(path, 0, 20)), to: getAddress(slice(path, -20)) };
  }
  if (command === 0x08) {
    const [recipient, amountIn, , path, payerIsUser] = decodeAbiParameters(V2_SWAP, input);
    if (payerIsUser || path.length < 2) return undefined;
    return { recipient, amountIn, from: path[0], to: path[path.length - 1] };
  }
  return undefined;
}

// emitData only logs swap metadata.
function emitsOnly(calls: readonly Call[], across: AcrossContracts): boolean {
  if (calls.length > 2) return false;
  return calls.every((call) => {
    if (!across.eventEmitter || call.value !== 0n || !isAddressEqual(call.target, across.eventEmitter)) return false;
    const decoded = decodeFunctionData({ abi: EMITTER_ABI, data: call.callData });
    return encodeFunctionData({ abi: EMITTER_ABI, ...decoded }) === call.callData;
  });
}

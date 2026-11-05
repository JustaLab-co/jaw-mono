import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { readBridgeApprove } from './approve';
import type { BridgeContracts } from './table';
import { callValue, tokenAmount, type BridgeCall, type Inert, type TokenAmount, type Unreadable } from './view';

const DEPOSITORY_ABI = parseAbi([
  'function depositNative(address depositor, bytes32 id)',
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
]);

const PROXY_ABI = parseAbi([
  'function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata)',
]);

export type RelayDeposit = { kind: 'deposit'; provider: 'relay'; send: TokenAmount; depositor: Address; orderId: Hex };

export function readRelayCall(
  contracts: BridgeContracts,
  call: BridgeCall
): RelayDeposit | Inert | Unreadable | undefined {
  const depository = contracts.chain(call.chainId)?.relay?.depository;
  if (!depository || !isAddress(call.to, { strict: false }) || !isAddressEqual(call.to, depository)) return undefined;
  return depositOf(contracts, call) ?? { kind: 'unreadable', what: 'deposit' };
}

/** A same-chain swap through Relay's approval proxy. What it pulls is read; what it pays out is not in the call. */
export type RelaySwap = { kind: 'swap'; provider: 'relay'; send: TokenAmount };

/**
 * The proxy pulls exactly `tokens` and `amounts` from the account into Relay's router, which runs
 * the inner calls with only those funds and returns what is left to `refundTo`. The summary claims
 * nothing about the inner calls, so they are not read.
 */
export function readRelaySwap(
  contracts: BridgeContracts,
  call: BridgeCall,
  account: Address,
  before: BridgeCall | undefined
): RelaySwap | Unreadable | undefined {
  const proxies = contracts.chain(call.chainId)?.relay?.approvalProxies ?? [];
  const { to } = call;
  if (!isAddress(to, { strict: false }) || !proxies.some((proxy) => isAddressEqual(proxy, to))) return undefined;
  return swapOf(contracts, call, account, before) ?? { kind: 'unreadable', what: 'deposit' };
}

// One token, pulled for the exact amount in the call. Relay leaves the approve out when the allowance
// already covers it, but an approve right before it must be on the same chain, for this proxy, and
// for exactly the token and amount pulled.
function swapOf(
  contracts: BridgeContracts,
  call: BridgeCall,
  account: Address,
  before: BridgeCall | undefined
): RelaySwap | undefined {
  const swap = decodeSwap(call.data);
  if (!swap || callValue(call.value) !== 0n) return undefined;
  const [tokens, amounts, , refundTo, nftRecipient] = swap.args;
  if (tokens.length !== 1 || amounts.length !== 1) return undefined;
  if (!isAddressEqual(refundTo, account) || !isAddressEqual(nftRecipient, account)) return undefined;
  const read: RelaySwap = {
    kind: 'swap',
    provider: 'relay',
    send: tokenAmount(contracts, call.chainId, tokens[0], amounts[0]),
  };

  const approve = before && readBridgeApprove(contracts, before);
  if (approve?.kind !== 'approve') return read;
  if (before?.chainId !== call.chainId || !isAddressEqual(approve.spender, getAddress(call.to))) return undefined;
  if (!isAddressEqual(approve.token.address, tokens[0]) || approve.amount !== amounts[0]) return undefined;
  return read;
}

function depositOf(contracts: BridgeContracts, call: BridgeCall): RelayDeposit | Inert | undefined {
  const deposit = decodeExact(call.data);
  const value = callValue(call.value);
  if (!deposit || value === undefined) return undefined;

  if (deposit.functionName === 'depositNative') {
    const [depositor, orderId] = deposit.args;
    // The depository only records a deposit of zero (RelayDepository.depositNative).
    if (value === 0n) return { kind: 'inert' };
    return {
      kind: 'deposit',
      provider: 'relay',
      send: tokenAmount(contracts, call.chainId, zeroAddress, value),
      depositor,
      orderId,
    };
  }

  const [depositor, token, amount, orderId] = deposit.args;
  if (value !== 0n || token === zeroAddress) return undefined;
  return {
    kind: 'deposit',
    provider: 'relay',
    send: tokenAmount(contracts, call.chainId, token, amount),
    depositor,
    orderId,
  };
}

function decodeExact(data: string | undefined) {
  if (!data) return undefined;
  const hex = data.toLowerCase() as Hex;
  try {
    const call = decodeFunctionData({ abi: DEPOSITORY_ABI, data: hex });
    return encodeFunctionData({ abi: DEPOSITORY_ABI, ...call }) === hex ? call : undefined;
  } catch {
    return undefined;
  }
}

// Relay appends the quote's request id after the arguments, which Solidity ignores.
function decodeSwap(data: string | undefined) {
  if (!data) return undefined;
  const hex = data.toLowerCase() as Hex;
  try {
    const call = decodeFunctionData({ abi: PROXY_ABI, data: hex });
    const args = encodeFunctionData({ abi: PROXY_ABI, ...call });
    return hex.startsWith(args) && /^(?:[0-9a-f]{2})*$/.test(hex.slice(args.length)) ? call : undefined;
  } catch {
    return undefined;
  }
}

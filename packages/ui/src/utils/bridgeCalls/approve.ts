import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { decodeAllowanceChange } from '../allowances';
import { BRIDGE_CHAINS, type BridgeChain } from './contracts';
import { callValue, tokenOf, type BridgeCall, type BridgeProvider, type Token, type Unreadable } from './view';

const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount)']);

export type BridgeApprove = {
  kind: 'approve';
  provider: BridgeProvider;
  token: Token;
  amount: bigint;
  spender: Address;
};

export function readBridgeApprove(call: BridgeCall): BridgeApprove | Unreadable | undefined {
  const chain = BRIDGE_CHAINS[call.chainId];
  const change = decodeAllowanceChange(call);
  const provider = chain && change && spenderProvider(chain, change.spender);
  if (!provider) return undefined;
  if (change.amount === undefined || !isPlainApprove(call)) return { kind: 'unreadable', provider };

  return {
    kind: 'approve',
    provider,
    token: tokenOf(call.chainId, getAddress(call.to)),
    amount: change.amount,
    spender: getAddress(change.spender),
  };
}

function spenderProvider(chain: BridgeChain, spender: string): BridgeProvider | undefined {
  const { across, relay } = chain;
  if (!isAddress(spender, { strict: false })) return undefined;
  if (across && [across.spokePool, across.periphery].some((address) => isAddressEqual(address, spender)))
    return 'across';
  if (relay && isAddressEqual(relay.depository, spender)) return 'relay';
  return undefined;
}

function isPlainApprove({ data, value }: BridgeCall): boolean {
  if (!data || callValue(value) !== 0n) return false;
  const hex = data.toLowerCase() as Hex;
  try {
    const call = decodeFunctionData({ abi: APPROVE_ABI, data: hex });
    return encodeFunctionData({ abi: APPROVE_ABI, ...call }) === hex;
  } catch {
    return false;
  }
}

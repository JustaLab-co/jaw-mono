import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { BRIDGE_CHAINS } from './contracts';
import { callValue, tokenAmount, type BridgeCall, type TokenAmount, type Unreadable } from './view';

const DEPOSITORY_ABI = parseAbi([
  'function depositNative(address depositor, bytes32 id)',
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
]);

export type RelayDeposit = { kind: 'deposit'; provider: 'relay'; send: TokenAmount; depositor: Address; orderId: Hex };

export function readRelayCall(call: BridgeCall): RelayDeposit | Unreadable | undefined {
  const depository = BRIDGE_CHAINS[call.chainId]?.relay?.depository;
  if (!depository || !isAddress(call.to, { strict: false }) || !isAddressEqual(call.to, depository)) return undefined;
  return depositOf(call) ?? { kind: 'unreadable', provider: 'relay' };
}

function depositOf(call: BridgeCall): RelayDeposit | undefined {
  const deposit = decodeExact(call.data);
  const value = callValue(call.value);
  if (!deposit || value === undefined) return undefined;

  if (deposit.functionName === 'depositNative') {
    const [depositor, orderId] = deposit.args;
    if (value === 0n) return undefined;
    return {
      kind: 'deposit',
      provider: 'relay',
      send: tokenAmount(call.chainId, zeroAddress, value),
      depositor,
      orderId,
    };
  }

  const [depositor, token, amount, orderId] = deposit.args;
  if (value !== 0n || token === zeroAddress) return undefined;
  return { kind: 'deposit', provider: 'relay', send: tokenAmount(call.chainId, token, amount), depositor, orderId };
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

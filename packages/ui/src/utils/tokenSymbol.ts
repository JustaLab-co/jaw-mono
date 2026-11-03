import { decodeFunctionResult, encodeFunctionData, hexToString, parseAbi, type Hex } from 'viem';

const STRING_ABI = parseAbi(['function symbol() view returns (string)']);
// Older tokens (MKR style) return the symbol as bytes32 instead of a string.
const BYTES32_ABI = parseAbi(['function symbol() view returns (bytes32)']);
const PRINTABLE = /^[\x20-\x7E]{1,16}$/;

export const SYMBOL_CALLDATA = encodeFunctionData({ abi: STRING_ABI, functionName: 'symbol' });

function decode(data: Hex): string {
  try {
    return decodeFunctionResult({ abi: STRING_ABI, functionName: 'symbol', data });
  } catch {
    return hexToString(decodeFunctionResult({ abi: BYTES32_ABI, functionName: 'symbol', data }), { size: 32 });
  }
}

/** The symbol in a `symbol()` answer, string or bytes32, when it is short printable text. */
export function decodeSymbol(data: Hex): string | undefined {
  try {
    const symbol = decode(data).trim();
    return PRINTABLE.test(symbol) ? symbol : undefined;
  } catch {
    return undefined;
  }
}

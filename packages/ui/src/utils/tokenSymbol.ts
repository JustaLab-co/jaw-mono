import { BaseError, decodeFunctionResult, encodeFunctionData, hexToString, parseAbi, type Hex } from 'viem';

const STRING_ABI = parseAbi(['function symbol() view returns (string)']);
// Older tokens (MKR style) return the symbol as bytes32 instead of a string.
const BYTES32_ABI = parseAbi(['function symbol() view returns (bytes32)']);
// Printable ASCII plus symbol characters, so `USD₮0` keeps its name. Letters stay ASCII so a
// look-alike such as a Cyrillic `С` cannot pass for `USDC`. The replacement character is what a
// bytes32 that is not UTF-8 decodes to.
const PRINTABLE = /^(?!.*\uFFFD)[\x20-\x7E\p{S}]{1,16}$/u;

// A bytes32 answer reaches the string decoder as bytes it cannot read, and these are how that fails.
const DECODE_ERRORS = ['AbiDecodingDataSizeTooSmallError', 'PositionOutOfBoundsError', 'IntegerOutOfRangeError'];

export const SYMBOL_CALLDATA = encodeFunctionData({ abi: STRING_ABI, functionName: 'symbol' });

function isDecodeError(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    e.walk((cause) => cause instanceof BaseError && DECODE_ERRORS.includes(cause.name)) !== null
  );
}

function decode(data: Hex): string {
  try {
    return decodeFunctionResult({ abi: STRING_ABI, functionName: 'symbol', data });
  } catch (e) {
    if (!isDecodeError(e)) throw e;
    return hexToString(decodeFunctionResult({ abi: BYTES32_ABI, functionName: 'symbol', data }), { size: 32 });
  }
}

/** The symbol trimmed, when it is 1 to 16 printable characters. */
export function cleanSymbol(symbol: string | undefined): string | undefined {
  const trimmed = symbol?.trim();
  return trimmed && PRINTABLE.test(trimmed) ? trimmed : undefined;
}

/** The symbol in a `symbol()` answer, string or bytes32, when it is 1 to 16 printable characters. */
export function decodeSymbol(data: Hex): string | undefined {
  try {
    return cleanSymbol(decode(data));
  } catch {
    return undefined;
  }
}

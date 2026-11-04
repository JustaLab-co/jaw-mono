import { decodeFunctionData, encodeFunctionData, toFunctionSelector, type Abi, type Hex } from 'viem';
import type { DecodedCalldata } from '../hooks/useDecodedCalldata';

function formatParamValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatParamValue).join(', ')}]`;
  if (typeof value === 'object' && value !== null)
    return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  return String(value);
}

/**
 * Decodes calldata with the ABI entry whose selector it starts with. When the entry re-encodes to
 * the start of the calldata, the bytes after it are the suffix. When it does not, as with dirty high
 * bytes in an address word or nonzero padding after a bytesN value, the decode is kept and marked
 * non-canonical, since the contract may still run it. Dirty high bits in an integer word make viem
 * throw, so that call returns null, as does calldata with an odd number of hex digits. The signature
 * fits the bytes and hashes to the selector, which does not prove it is the contract's real one: the
 * ABI comes from an open lookup.
 */
export function decodeWithAbi(abi: Abi, data: Hex): DecodedCalldata | null {
  // viem pads an odd number of hex digits with a nibble, which shifts every word it decodes.
  if (data.length % 2 !== 0) return null;
  const selector = data.slice(0, 10).toLowerCase();
  // whatsabi leaves selectors it cannot resolve without a name or inputs, which cannot be hashed.
  const item = abi.find(
    (entry) => entry.type === 'function' && entry.name && entry.inputs && toFunctionSelector(entry) === selector
  );
  if (item?.type !== 'function') return null;

  try {
    const { args } = decodeFunctionData({ abi: [item], data });
    const canonical = encodeFunctionData({ abi: [item], functionName: item.name, args });
    const isCanonical = data.toLowerCase().startsWith(canonical.toLowerCase());
    const tail = isCanonical ? data.slice(canonical.length) : '';
    const extraBytes = isCanonical ? 0 : (data.length - canonical.length) / 2;
    const { inputs } = item;
    return {
      functionName: item.name,
      signature: `${item.name}(${inputs.map((inp) => inp.type).join(', ')})`,
      params: (args ?? []).map((arg, i) => ({
        name: inputs[i].name || `param${i}`,
        type: inputs[i].type,
        value: formatParamValue(arg),
        ...(inputs[i].type === 'address' && typeof arg === 'string' ? { rawValue: arg } : {}),
      })),
      ...(tail ? { trailing: `0x${tail}` as Hex } : {}),
      ...(isCanonical ? {} : { nonCanonical: true }),
      ...(extraBytes > 0 ? { extraBytes } : {}),
    };
  } catch (err) {
    console.debug('[useDecodedCalldata] raw decode failed:', err);
    return null;
  }
}

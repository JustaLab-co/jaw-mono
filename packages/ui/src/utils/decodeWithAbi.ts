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
 * Decodes calldata with the ABI entry whose selector it starts with, and shows it only when the
 * entry re-encodes to the calldata, or to its start with a suffix after it. This is a consistency
 * check: the signature fits the bytes and hashes to the selector. It does not prove the signature
 * is the contract's real one, since the ABI comes from an open lookup.
 */
export function decodeWithAbi(abi: Abi, data: Hex): DecodedCalldata | null {
  const selector = data.slice(0, 10).toLowerCase();
  // whatsabi leaves selectors it cannot resolve without a name or inputs, which cannot be hashed.
  const item = abi.find(
    (entry) => entry.type === 'function' && entry.name && entry.inputs && toFunctionSelector(entry) === selector
  );
  if (item?.type !== 'function') return null;

  try {
    const { args } = decodeFunctionData({ abi: [item], data });
    const canonical = encodeFunctionData({ abi: [item], functionName: item.name, args });
    if (!data.toLowerCase().startsWith(canonical.toLowerCase())) return null;

    const tail = data.slice(canonical.length);
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
    };
  } catch (err) {
    console.debug('[useDecodedCalldata] raw decode failed:', err);
    return null;
  }
}

import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Hex,
} from 'viem';
import { formatAbiParams } from 'viem/utils';

export interface DecodedParam {
  name: string;
  type: string;
  value: string;
  rawValue?: string;
}

export interface DecodedCalldata {
  functionName: string;
  signature: string;
  params: DecodedParam[];
  /** Bytes after the last argument (a builder-code or referral suffix), when the call has any. */
  trailing?: Hex;
  /**
   * The ABI decodes the calldata but does not re-encode to it. The shown values may differ from what
   * the contract reads, and the suffix cannot be told apart.
   */
  nonCanonical?: boolean;
  /** On a non-canonical decode, how many bytes the calldata runs past what its arguments re-encode to. */
  extraBytes?: number;
}

function formatParamValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatParamValue).join(', ')}]`;
  if (typeof value === 'object' && value !== null)
    return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  return String(value);
}

const selectorMaps = new WeakMap<Abi, Map<string, AbiFunction>>();

/** Each function's selector, built once per ABI. The first entry with a selector wins. */
function functionsBySelector(abi: Abi): Map<string, AbiFunction> {
  const cached = selectorMaps.get(abi);
  if (cached) return cached;

  const bySelector = new Map<string, AbiFunction>();
  for (const entry of abi) {
    // whatsabi leaves selectors it cannot resolve without a name or inputs, which cannot be hashed.
    if (entry.type !== 'function' || !entry.name || !entry.inputs) continue;
    try {
      const selector = toFunctionSelector(entry);
      if (!bySelector.has(selector)) bySelector.set(selector, entry);
    } catch (err) {
      console.debug('[decodeWithAbi] skipped an ABI entry that cannot be hashed:', err);
    }
  }
  selectorMaps.set(abi, bySelector);
  return bySelector;
}

// `string` and `bytes` share one encoding. Read as bytes, a string holding invalid UTF-8 re-encodes to
// its own bytes and not to the U+FFFD it is shown as.
function asBytes(param: AbiParameter): AbiParameter {
  if ('components' in param) return { ...param, components: param.components.map(asBytes) };
  return { ...param, type: param.type.replace(/^string/, 'bytes') } as AbiParameter;
}

/** The calldata its own decode re-encodes to, or null when a decoded value does not fit its type. */
function reencode(item: AbiFunction, data: Hex): Hex | null {
  const params = item.inputs.map(asBytes);
  // With no params, viem would reject a suffix shorter than a word.
  const values = params.length > 0 ? decodeAbiParameters(params, `0x${data.slice(10)}`) : [];
  try {
    return `${data.slice(0, 10)}${encodeAbiParameters(params, values).slice(2)}` as Hex;
  } catch {
    // viem reads a whole word for any integer, so dirty high bits decode past the type's range.
    return null;
  }
}

/**
 * Decodes calldata with the ABI entry whose selector it starts with. When the entry re-encodes to
 * the start of the calldata, the bytes after it are the suffix. When it does not, as with dirty high
 * bytes in an address or integer word or nonzero padding after a bytesN value, the decode is kept and
 * marked non-canonical, since the contract may still run it. An integer type of 48 bits or less whose
 * word reads past a safe JS integer makes viem throw, so that call returns null, as does calldata with
 * an odd number of hex digits. The signature fits the bytes and hashes to the selector, which does not
 * prove it is the contract's real one: the ABI comes from an open lookup.
 */
export function decodeWithAbi(abi: Abi, data: Hex): DecodedCalldata | null {
  // viem pads an odd number of hex digits with a nibble, which shifts every word it decodes.
  if (data.length % 2 !== 0) return null;
  const item = functionsBySelector(abi).get(data.slice(0, 10).toLowerCase());
  if (!item) return null;

  try {
    const { args } = decodeFunctionData({ abi: [item], data });
    const canonical = reencode(item, data);
    const isCanonical = canonical !== null && data.toLowerCase().startsWith(canonical.toLowerCase());
    const tail = isCanonical ? data.slice(canonical.length) : '';
    const extraBytes = canonical && !isCanonical ? (data.length - canonical.length) / 2 : 0;
    const { inputs } = item;
    // A struct shows as its component types, (address,uint256), the form the selector hashes.
    const types = inputs.map((inp) => formatAbiParams([inp]));
    return {
      functionName: item.name,
      signature: `${item.name}(${types.join(', ')})`,
      params: (args ?? []).map((arg, i) => ({
        name: inputs[i].name || `param${i}`,
        type: types[i],
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

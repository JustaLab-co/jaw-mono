import type { Call, CallPreview } from '@jaw.id/agent';
import { decodeFunctionData, erc20Abi, maxUint256, size, toFunctionSignature } from 'viem';

const KNOWN = erc20Abi.filter(
  (item) => item.type === 'function' && ['transfer', 'approve', 'transferFrom'].includes(item.name)
);

/** A call as the approval page shows it: decoded when a known ABI matches, raw calldata otherwise. */
export function describeCall(call: Call): CallPreview {
  const bytes = size(call.data);
  if (bytes === 0) return { ...call, warnings: [] };
  if (bytes < 4) return { ...call, warnings: [{ code: 'short_calldata' }] };
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: KNOWN, data: call.data });
  } catch {
    return { ...call, warnings: [{ code: 'unknown_function' }] };
  }
  const item = KNOWN.find((f) => f.name === decoded.functionName)!;
  const named = {
    ...call,
    function: toFunctionSignature(item),
    args: item.inputs.map((input, i) => ({ name: input.name, type: input.type, value: String(decoded.args[i]) })),
  };
  if (decoded.functionName !== 'approve') return { ...named, warnings: [] };
  const [spender, amount] = decoded.args;
  return {
    ...named,
    warnings: [{ code: 'token_approval', spender, amount: amount.toString(), unlimited: amount === maxUint256 }],
  };
}

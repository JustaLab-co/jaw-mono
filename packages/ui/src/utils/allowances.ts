import { decodeFunctionData, isAddressEqual, maxUint160, parseAbi } from 'viem';

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const UNLIMITED_FLOOR = 1n << 255n;

const TOKEN_ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function setApprovalForAll(address operator, bool approved)',
]);
const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

export interface AllowanceChange {
  /** The token or collection whose allowance changes. */
  token: string;
  /** The spender or operator being granted access. */
  spender: string;
  /** Raw amount; absent for an NFT-wide approval. */
  amount?: bigint;
  /** `increaseAllowance` adds to the current allowance instead of setting it. */
  added: boolean;
  /** Access to every token of a collection. */
  allTokens: boolean;
  unlimited: boolean;
  revoke: boolean;
}

interface Call {
  to?: string;
  data?: string;
}

/**
 * Reads an allowance change out of one call's calldata. `approve` shares its selector between
 * ERC-20 and ERC-721, so an ERC-721 token id decodes as an amount here.
 */
export function decodeAllowanceChange({ to, data }: Call): AllowanceChange | null {
  if (!to || !data || data === '0x') return null;
  try {
    return isAddressEqual(to as `0x${string}`, PERMIT2_ADDRESS) ? decodePermit2(data) : decodeToken(to, data);
  } catch {
    return null;
  }
}

function decodeToken(token: string, data: string): AllowanceChange | null {
  const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: data as `0x${string}` });
  if (decoded.functionName === 'setApprovalForAll') {
    const [operator, approved] = decoded.args;
    if (!approved) return null;
    return { token, spender: operator, added: false, allTokens: true, unlimited: true, revoke: false };
  }
  const [spender, amount] = decoded.args;
  return {
    token,
    spender,
    amount,
    added: decoded.functionName === 'increaseAllowance',
    allTokens: false,
    unlimited: amount >= UNLIMITED_FLOOR,
    revoke: amount === 0n && decoded.functionName === 'approve',
  };
}

function decodePermit2(data: string): AllowanceChange {
  const { args } = decodeFunctionData({ abi: PERMIT2_ABI, data: data as `0x${string}` });
  const [token, spender, amount] = args;
  return {
    token,
    spender,
    amount,
    added: false,
    allTokens: false,
    unlimited: amount >= maxUint160,
    revoke: amount === 0n,
  };
}

export function allowanceChanges(calls: Call[]): AllowanceChange[] {
  return calls.flatMap((call) => decodeAllowanceChange(call) ?? []);
}

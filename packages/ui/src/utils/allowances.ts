import { decodeFunctionData, isAddress, isAddressEqual, maxUint160, parseAbi, toFunctionSelector } from 'viem';

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const UNLIMITED_FLOOR = 1n << 255n;

const TOKEN_ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function increaseApproval(address spender, uint256 addedValue)',
  'function approveAndCall(address spender, uint256 amount)',
  'function approveAndCall(address spender, uint256 amount, bytes data)',
  'function setApprovalForAll(address operator, bool approved)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);
const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

const TOKEN_SELECTORS = new Set<string>(TOKEN_ABI.map((item) => toFunctionSelector(item)));
const PERMIT2_SELECTORS = new Set<string>(PERMIT2_ABI.map((item) => toFunctionSelector(item)));

export interface AllowanceChange {
  /** The token or collection whose allowance changes. */
  token: string;
  /** The spender or operator being granted access. */
  spender: string;
  /** Raw amount; absent for an NFT-wide approval. */
  amount?: bigint;
  /** An increase adds to the current allowance instead of setting it. */
  added: boolean;
  /** Access to every token of a collection. */
  allTokens: boolean;
  unlimited: boolean;
  /** Sets the allowance to zero. */
  revoke: boolean;
  /** `approve` shares its selector with ERC-721, so the target may not be an ERC-20 at all. */
  ambiguous: boolean;
  /** The signer of an on-chain EIP-2612 permit. */
  owner?: string;
  /** The selector is an allowance one but the arguments did not decode, so the spender is unknown (empty). */
  undecoded?: boolean;
}

interface Call {
  to?: string;
  data?: string;
}

/**
 * Reads an allowance change out of one call's calldata. `approve` shares its selector between
 * ERC-20 and ERC-721, so an ERC-721 token id decodes as an amount here (see `ambiguous`).
 * The hex is lowercased for decoding only, the request that gets signed is not touched.
 */
export function decodeAllowanceChange({ to, data }: Call): AllowanceChange | null {
  if (!to || !data || data === '0x' || !isAddress(to, { strict: false })) return null;
  const calldata = data.toLowerCase();
  const isPermit2 = isAddressEqual(to, PERMIT2_ADDRESS);
  try {
    return isPermit2 ? decodePermit2(calldata) : decodeToken(to, calldata);
  } catch {
    const known = isPermit2 ? PERMIT2_SELECTORS : TOKEN_SELECTORS;
    return known.has(calldata.slice(0, 10)) ? undecodedChange(to) : null;
  }
}

function undecodedChange(token: string): AllowanceChange {
  return {
    token,
    spender: '',
    added: false,
    allTokens: false,
    unlimited: false,
    revoke: false,
    ambiguous: false,
    undecoded: true,
  };
}

function decodeToken(token: string, data: string): AllowanceChange | null {
  const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: data as `0x${string}` });
  if (decoded.functionName === 'setApprovalForAll') {
    const [operator, approved] = decoded.args;
    if (!approved) return null;
    return {
      token,
      spender: operator,
      added: false,
      allTokens: true,
      unlimited: true,
      revoke: false,
      ambiguous: false,
    };
  }
  if (decoded.functionName === 'permit') {
    const [owner, spender, value] = decoded.args;
    return { ...amountChange(token, spender, value, false), owner };
  }
  const [spender, amount] = decoded.args;
  const added = decoded.functionName === 'increaseAllowance' || decoded.functionName === 'increaseApproval';
  return { ...amountChange(token, spender, amount, added), ambiguous: decoded.functionName === 'approve' };
}

function amountChange(token: string, spender: string, amount: bigint, added: boolean): AllowanceChange {
  return {
    token,
    spender,
    amount,
    added,
    allTokens: false,
    unlimited: amount >= UNLIMITED_FLOOR,
    revoke: amount === 0n && !added,
    ambiguous: false,
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
    ambiguous: false,
  };
}

export function allowanceChanges(calls: Call[]): AllowanceChange[] {
  return calls.flatMap((call) => decodeAllowanceChange(call) ?? []);
}

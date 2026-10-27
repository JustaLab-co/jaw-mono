import {
  decodeFunctionData,
  isAddress,
  isAddressEqual,
  maxUint160,
  maxUint256,
  parseAbi,
  toFunctionSelector,
} from 'viem';
import { isUnlimitedAmount } from './displayFormat';

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const TOKEN_ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function increaseApproval(address spender, uint256 addedValue)',
  'function approveAndCall(address spender, uint256 amount)',
  'function approveAndCall(address spender, uint256 amount, bytes data)',
  'function setApprovalForAll(address operator, bool approved)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  // DAI's permit predates EIP-2612: `allowed` sets the allowance to max uint256 or to zero.
  'function permit(address holder, address spender, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s)',
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
  /**
   * `approve` shares its selector with ERC-721, so the target may not be an ERC-20 at all and the
   * amount may be a token id. It is unlimited only at exactly max uint256 or max uint160.
   */
  ambiguous: boolean;
  /** The signer of an on-chain EIP-2612 or DAI permit. */
  owner?: string;
  /** The selector is an allowance one but the arguments did not decode, so the spender is unknown (empty). */
  undecoded?: boolean;
  /** Index of the call argument that sets the allowance: the amount, or the `approved`/`allowed` flag. */
  argIndex?: number;
}

export interface Call {
  to?: string;
  data?: string;
}

/** The amber warning for one call: an unlimited allowance, or access to a whole collection. */
export interface AllowanceFlag {
  label: 'Unlimited' | 'All tokens';
  /** The call argument the flag stands for in the decoded calldata. */
  argIndex: number;
  /** The approved amount; absent for a whole collection. */
  amount?: bigint;
}

/**
 * The flag for one call, or null. Allowances move no balance, so the simulation shows nothing for
 * them, yet they let the spender take funds later. The screen shows it only once the calldata
 * lookup has read the call (`readableFlag`).
 */
export function allowanceFlag(call: Call): AllowanceFlag | null {
  const change = decodeAllowanceChange(call);
  if (!change?.unlimited || change.argIndex === undefined) return null;
  return change.allTokens
    ? { label: 'All tokens', argIndex: change.argIndex }
    : { label: 'Unlimited', argIndex: change.argIndex, amount: change.amount };
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
      argIndex: 1,
    };
  }
  if (decoded.functionName === 'permit') {
    if (decoded.args.length === 8) {
      const [holder, spender, , , allowed] = decoded.args;
      return { ...amountChange(token, spender, allowed ? maxUint256 : 0n, false), owner: holder, argIndex: 4 };
    }
    const [owner, spender, value] = decoded.args;
    return { ...amountChange(token, spender, value, false), owner, argIndex: 2 };
  }
  const [spender, amount] = decoded.args;
  const added = decoded.functionName === 'increaseAllowance' || decoded.functionName === 'increaseApproval';
  const ambiguous = decoded.functionName === 'approve';
  const change = amountChange(token, spender, amount, added);
  return {
    ...change,
    unlimited: ambiguous ? isUnlimitedAmount(amount) : change.unlimited,
    ambiguous,
    argIndex: 1,
  };
}

function amountChange(token: string, spender: string, amount: bigint, added: boolean): AllowanceChange {
  return {
    token,
    spender,
    amount,
    added,
    allTokens: false,
    // From max uint160 up an allowance is unlimited in practice; Permit2's amount tops out there.
    unlimited: amount >= maxUint160,
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
    argIndex: 2,
  };
}

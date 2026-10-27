import { maxUint256 } from 'viem';
import { decodeAllowanceChange, type AllowanceChange, type Call } from '../utils/allowances';
import type { AssetDelta } from '../utils/assetPreview';
import { useApprovalTokenKinds } from './useApprovalTokenKind';

export interface AllowanceFlag {
  label: 'Unlimited' | 'All tokens';
  /** The call argument the flag stands in for in the decoded calldata. */
  argIndex: number;
  /** The approved amount; absent for a whole collection. */
  amount?: bigint;
}

/**
 * An `approve` from max uint160 up may be an ERC-721 token id (an ENS name's id is its labelhash),
 * so the token is read before it is flagged. Exactly max uint256 is taken as an ERC-20 allowance,
 * and so is a token the simulation moved with decimals: an ERC-721 there has 0.
 */
function needsNftCheck(change: AllowanceChange, knownTokens: AssetDelta[]): boolean {
  if (!change.ambiguous || change.amount === maxUint256) return false;
  const known = knownTokens.find((d) => !d.isNative && d.address.toLowerCase() === change.token.toLowerCase());
  return !(known && known.decimals > 0);
}

/**
 * The amber flag for each call, by index: unlimited allowances and `setApprovalForAll`. They move
 * no balance, so the simulation shows nothing for them, yet they let the spender take funds later.
 * Decoded locally from known selectors; the screen shows it only once the lookup has read the
 * call (`readableFlag`). A call that needs a token read waits for it; only a confirmed ERC-721 is
 * left unflagged, and a failed or stalled read still flags.
 */
export function useAllowanceFlags(
  calls: Call[],
  knownTokens: AssetDelta[],
  chainId: number | undefined,
  apiKey: string | undefined
): (AllowanceFlag | null)[] {
  const candidates = calls.map((call) => {
    const change = decodeAllowanceChange(call);
    if (!change?.unlimited || change.argIndex === undefined) return null;
    return { change, argIndex: change.argIndex, needsRead: needsNftCheck(change, knownTokens) };
  });
  const kinds = useApprovalTokenKinds(
    candidates.flatMap((entry) => (entry?.needsRead ? [entry.change.token] : [])),
    chainId,
    apiKey
  );
  return candidates.map((entry) => {
    if (!entry) return null;
    if (entry.needsRead) {
      const kind = kinds[entry.change.token.toLowerCase()];
      if (kind !== 'not-erc721' && kind !== 'unknown') return null;
    }
    const { allTokens, amount } = entry.change;
    return allTokens
      ? { label: 'All tokens', argIndex: entry.argIndex }
      : { label: 'Unlimited', argIndex: entry.argIndex, amount };
  });
}

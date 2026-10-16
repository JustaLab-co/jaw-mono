import { useEffect, useState } from 'react';
import { erc20Abi, parseAbi } from 'viem';
import { getJawPublicClient } from '../utils/publicClient';

const ERC721_INTERFACE_ID = '0x80ac58cd';
const erc165Abi = parseAbi(['function supportsInterface(bytes4 interfaceId) view returns (bool)']);

export type ApprovalTokenKind =
  | { status: 'loading' }
  | { status: 'erc721' }
  | { status: 'erc20'; decimals: number }
  | { status: 'unknown' };

const UNKNOWN: ApprovalTokenKind = { status: 'unknown' };
const LOADING: ApprovalTokenKind = { status: 'loading' };

async function readKind(token: string, chainId: number, apiKey?: string): Promise<ApprovalTokenKind> {
  const client = getJawPublicClient(chainId, apiKey);
  const address = token as `0x${string}`;
  // An ERC-20 has no supportsInterface, so a revert there is an answer, not a failure.
  const isNft = await client
    .readContract({ address, abi: erc165Abi, functionName: 'supportsInterface', args: [ERC721_INTERFACE_ID] })
    .catch(() => false);
  if (isNft) return { status: 'erc721' };
  const decimals = await client.readContract({ address, abi: erc20Abi, functionName: 'decimals' });
  return { status: 'erc20', decimals };
}

/**
 * Tells an ERC-721 from an ERC-20 for an `approve` call, which has the same selector on both.
 * Display only: a failed read leaves the kind unknown and never blocks the dialog.
 */
export function useApprovalTokenKind(
  token: string,
  chainId: number | undefined,
  apiKey: string | undefined,
  enabled: boolean
): ApprovalTokenKind {
  const active = enabled && chainId !== undefined;
  const [kind, setKind] = useState<ApprovalTokenKind>(active ? LOADING : UNKNOWN);

  useEffect(() => {
    if (!enabled || chainId === undefined) {
      setKind(UNKNOWN);
      return;
    }
    let cancelled = false;
    setKind(LOADING);
    readKind(token, chainId, apiKey)
      .catch((err) => {
        console.debug('[useApprovalTokenKind] read failed:', err);
        return UNKNOWN;
      })
      .then((next) => {
        if (!cancelled) setKind(next);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, token, chainId, apiKey]);

  return active ? kind : UNKNOWN;
}

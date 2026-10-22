import { useEffect, useState } from 'react';
import { parseAbi } from 'viem';
import { getJawPublicClient } from '../utils/publicClient';

const ERC721_INTERFACE_ID = '0x80ac58cd';
const erc165Abi = parseAbi(['function supportsInterface(bytes4 interfaceId) view returns (bool)']);

/** A read that has not answered by then counts as failed, so a stalled node cannot keep a warning hidden. */
export const APPROVAL_TOKEN_READ_TIMEOUT_MS = 5_000;

export type ApprovalTokenKind = 'loading' | 'erc721' | 'not-erc721' | 'unknown';

async function readKind(token: string, chainId: number, apiKey?: string): Promise<ApprovalTokenKind> {
  const client = getJawPublicClient(chainId, apiKey);
  // An ERC-20 has no supportsInterface, so a revert there is an answer, not a failure.
  const isNft = await client
    .readContract({
      address: token as `0x${string}`,
      abi: erc165Abi,
      functionName: 'supportsInterface',
      args: [ERC721_INTERFACE_ID],
    })
    .catch(() => false);
  return isNft ? 'erc721' : 'not-erc721';
}

function withTimeout(read: Promise<ApprovalTokenKind>): Promise<ApprovalTokenKind> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ApprovalTokenKind>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), APPROVAL_TOKEN_READ_TIMEOUT_MS);
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

const allAs = (tokens: string[], kind: ApprovalTokenKind) =>
  Object.fromEntries(tokens.map((token) => [token, kind])) as Record<string, ApprovalTokenKind>;

/**
 * Tells which of the tokens behind `approve` calls are ERC-721s, since `approve` has the same
 * selector on both. Every token is read in one effect; the result is keyed by lowercased address.
 * Display only: a failed or stalled read is `unknown` and never blocks the dialog.
 */
export function useApprovalTokenKinds(
  tokens: readonly string[],
  chainId: number | undefined,
  apiKey: string | undefined
): Record<string, ApprovalTokenKind> {
  const list = [...new Set(tokens.map((token) => token.toLowerCase()))].sort();
  const tokensKey = list.join(',');
  const key = `${chainId}|${apiKey ?? ''}|${tokensKey}`;
  const [read, setRead] = useState<{ key: string; kinds: Record<string, ApprovalTokenKind> }>();

  useEffect(() => {
    if (chainId === undefined || !tokensKey) return;
    const pending = tokensKey.split(',');
    const readKey = `${chainId}|${apiKey ?? ''}|${tokensKey}`;
    let cancelled = false;
    Promise.all(
      pending.map((token) =>
        withTimeout(readKind(token, chainId, apiKey)).catch((err) => {
          console.debug('[useApprovalTokenKinds] read failed:', err);
          return 'unknown' as const;
        })
      )
    ).then((kinds) => {
      if (!cancelled) setRead({ key: readKey, kinds: Object.fromEntries(pending.map((t, i) => [t, kinds[i]])) });
    });
    return () => {
      cancelled = true;
    };
  }, [tokensKey, chainId, apiKey]);

  if (chainId === undefined) return allAs(list, 'unknown');
  return read?.key === key ? read.kinds : allAs(list, 'loading');
}

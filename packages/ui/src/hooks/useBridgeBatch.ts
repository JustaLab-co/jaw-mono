import { useEffect, useMemo, useState } from 'react';
import { isAddress } from 'viem';
import { readBridgeBatch, readBridgeBatchWithUnread } from '../utils/bridgeCalls/batch';
import { readKey, type BridgeContracts, type TokenReads } from '../utils/bridgeCalls/table';
import { readTokens } from '../utils/bridgeCalls/readTokens';
import { getJawPublicClient } from '../utils/publicClient';
import type { TransactionData } from '../components/TransactionDialog/types';

/** `settled` is false until the tokens outside the table have answered, or failed to. */
export function useBridgeBatch(
  contracts: BridgeContracts,
  transactions: TransactionData[],
  account: string | undefined,
  relayOrder?: unknown,
  apiKey?: string
) {
  const first = useMemo(
    () =>
      account && isAddress(account, { strict: false })
        ? readBridgeBatchWithUnread(contracts, transactions, account, relayOrder)
        : null,
    [contracts, transactions, account, relayOrder]
  );
  const wanted = first?.unread ?? [];
  const wantedKey = [...new Set(wanted.map((ref) => readKey(ref.chainId, ref.address)))].sort().join();
  const [answer, setAnswer] = useState<{ key: string; reads: TokenReads }>();

  useEffect(() => {
    if (!wantedKey) return;
    let open = true;
    void readTokens(wanted, (chainId) => getJawPublicClient(chainId, apiKey)).then((reads) => {
      if (open) setAnswer({ key: wantedKey, reads });
    });
    return () => {
      open = false;
    };
  }, [wantedKey, apiKey]);

  const reads = answer?.key === wantedKey ? answer.reads : undefined;
  const bridge = useMemo(
    () =>
      reads?.size && account && isAddress(account, { strict: false })
        ? readBridgeBatch(contracts.withReads(reads), transactions, account, relayOrder)
        : (first?.batch ?? null),
    [first, reads, contracts, transactions, account, relayOrder]
  );
  return { bridge, settled: !wantedKey || reads !== undefined };
}

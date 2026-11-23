import { useEffect, useMemo, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { readAcrossAttestation, type AcrossAttestedOrder } from '../utils/bridgeCalls/acrossAttestation';
import { readBridgeBatch, readBridgeBatchWithUnread } from '../utils/bridgeCalls/batch';
import { readKey, type BridgeContracts, type TokenReads } from '../utils/bridgeCalls/table';
import { readTokens } from '../utils/bridgeCalls/readTokens';
import { getJawPublicClient } from '../utils/publicClient';
import type { TransactionData } from '../components/TransactionDialog/types';

export function useBridgeBatch(
  contracts: BridgeContracts,
  transactions: TransactionData[],
  account: string | undefined,
  capabilities?: Record<string, unknown>,
  apiKey?: string
) {
  const owner = account && isAddress(account, { strict: false }) ? account : undefined;
  const relayCapability = capabilities?.jawRelayOrder;
  const across = useAcrossOrder(capabilities?.jawAcrossOrder, transactions, owner);

  const first = useMemo(
    () => (owner ? readBridgeBatchWithUnread(contracts, transactions, owner, relayCapability, across.order) : null),
    [contracts, transactions, owner, relayCapability, across.order]
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
      reads?.size && owner
        ? readBridgeBatch(contracts.withReads(reads), transactions, owner, relayCapability, across.order)
        : (first?.batch ?? null),
    [first, reads, contracts, transactions, owner, relayCapability, across.order]
  );
  const tokensRead = !wantedKey || reads !== undefined;
  // Confirm waits until the tokens outside the table are read and the Across quote's signature is checked.
  return { bridge, tokensAndQuoteChecked: across.checked && tokensRead };
}

// setTimeout fires at once past this, and no dialog stays open that long.
const LONGEST_TIMEOUT = 2 ** 31 - 1;

function useAcrossOrder(capability: unknown, transactions: TransactionData[], owner: Address | undefined) {
  const key = useMemo(
    () => (capability === undefined || !owner ? '' : contentKey(capability, transactions, owner)),
    [capability, transactions, owner]
  );
  const [answer, setAnswer] = useState<{ key: string; order: AcrossAttestedOrder | null }>();

  useEffect(() => {
    if (!key || !owner) return;
    let open = true;
    void readAcrossAttestation(capability, transactions, owner).then((order) => {
      if (open) setAnswer({ key, order });
    });
    return () => {
      open = false;
    };
  }, [key]);

  const answered = answer?.key === key;
  const order = answered ? answer.order : null;

  // A dialog left open past expiresAt loses the order, as a fresh check would reject it.
  useEffect(() => {
    if (!order) return;
    const wait = order.expiresAt * 1000 - Date.now();
    if (wait > LONGEST_TIMEOUT) return;
    const expiry = setTimeout(() => setAnswer({ key, order: null }), wait);
    return () => clearTimeout(expiry);
  }, [order, key]);

  return { order, checked: !key || answered };
}

function contentKey(...parts: unknown[]): string {
  try {
    return JSON.stringify(parts);
  } catch {
    return '';
  }
}

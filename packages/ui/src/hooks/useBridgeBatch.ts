import { useMemo } from 'react';
import { isAddress } from 'viem';
import { readBridgeBatch } from '../utils/bridgeCalls/batch';
import type { BridgeContracts } from '../utils/bridgeCalls/table';
import type { TransactionData } from '../components/TransactionDialog/types';

export function useBridgeBatch(
  contracts: BridgeContracts,
  transactions: TransactionData[],
  account: string | undefined,
  relayOrder?: unknown
) {
  return useMemo(
    () =>
      account && isAddress(account, { strict: false })
        ? readBridgeBatch(contracts, transactions, account, relayOrder)
        : null,
    [contracts, transactions, account, relayOrder]
  );
}

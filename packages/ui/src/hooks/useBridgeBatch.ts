import { useMemo } from 'react';
import { isAddress } from 'viem';
import { readBridgeBatch } from '../utils/bridgeCalls/batch';
import type { TransactionData } from '../components/TransactionDialog/types';

export function useBridgeBatch(transactions: TransactionData[], account: string | undefined, relayOrder?: unknown) {
  return useMemo(
    () =>
      account && isAddress(account, { strict: false }) ? readBridgeBatch(transactions, account, relayOrder) : null,
    [transactions, account, relayOrder]
  );
}

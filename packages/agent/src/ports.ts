import type { PublicClient } from 'viem';
import type { X402LogEntry, X402SettlementCorrection } from './x402/ledger.js';

/** Read-only chain access, one client per chain id. */
export interface ChainClients {
  publicClient(chainId: number): PublicClient;
}

/**
 * Where payment rows are kept. Synchronous because the one store behind it, a
 * file, is.
 */
export interface PaymentLog {
  read(limit?: number): X402LogEntry[];
  append(entry: X402LogEntry): void;
  correct(correction: X402SettlementCorrection): void;
  compact(capStarts: string[] | undefined, payer: string | undefined): void;
}

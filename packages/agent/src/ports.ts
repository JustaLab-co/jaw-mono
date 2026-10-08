import type { PublicClient } from 'viem';
import type { X402LogEntry, X402SettlementCorrection } from './x402/ledger.js';
import type { GrantedPermission, SessionConfig } from './session/session-config.js';

/** Read-only chain access, one client per chain id. */
export interface ChainClients {
  publicClient(chainId: number): PublicClient;
}

/** Where payment rows are kept. A store that indexes rows by state derives it with `rowStateOf`. */
export interface PaymentLog {
  read(limit?: number): Promise<X402LogEntry[]>;
  append(entry: X402LogEntry): Promise<void>;
  correct(correction: X402SettlementCorrection): Promise<void>;
  compact(capStarts: string[] | undefined, payer: string | undefined): Promise<void>;
}

/** Where the agent says what an operator should see. The host picks the sink. */
export interface Logger {
  /** One line, without its trailing newline. */
  warn(message: string): void;
}

/** Where the session is kept. */
export interface PermissionStore {
  /** Write a recovered struct into the session; false when the session is gone. */
  saveRecovered(config: SessionConfig, permission: GrantedPermission): boolean;
}

/** What a session bridge reads from wherever the session is kept. */
export interface SessionHost {
  loadSession(): SessionConfig;
  /** The session key, hex. */
  loadSessionKey(): string;
  /** A paymaster configured for this chain, if any. */
  configuredPaymaster(chainId: number): { url: string; context?: Record<string, unknown> } | undefined;
  /**
   * A key to retry with after the proxy refused `refused`, or nothing when
   * there is none and the refusal should surface as is.
   */
  freshApiKey(err: unknown, refused: string): Promise<string | undefined>;
}

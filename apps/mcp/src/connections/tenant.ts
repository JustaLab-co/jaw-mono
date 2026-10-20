import type { Address, Hex } from 'viem';
import type { ConnectionRow } from './rows';
import type { ConnectionScope } from './scopes';

export interface Tenant {
  connectionId: string;
  account: Address;
  chainId: number;
  clientId: string;
  clientName: string;
  scopes: ConnectionScope[];
  sessionAddress: Address;
  expiresAt: Date;
  sessionKey(): Hex;
}

export const tenantOf = (row: ConnectionRow, scopes: ConnectionScope[], sessionKey: () => Hex): Tenant => ({
  connectionId: row.id,
  account: row.account as Address,
  chainId: row.chainId,
  clientId: row.clientId,
  clientName: row.clientName,
  scopes,
  sessionAddress: row.sessionAddress as Address,
  expiresAt: row.expiresAt,
  sessionKey,
});

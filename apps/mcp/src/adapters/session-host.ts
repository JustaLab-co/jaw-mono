import {
  Eip3009EoaPayer,
  SessionBridge,
  type ChainClients,
  type Logger,
  type Payer,
  type SessionConfig,
  type TopUpExecutor,
} from '@jaw.id/agent';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import type { Grant } from '@/grants/store';
import { publicClientFor } from '@/lib/chain';
import { log } from '@/lib/edge';

export const chainClients: ChainClients = { publicClient: publicClientFor };

export const agentLogger: Logger = {
  warn: (message) => log('warn', { msg: message.replace(/api-key=[^&\s]+/g, 'api-key=redacted') }),
};

export function sessionOf(grant: Grant): SessionConfig {
  return {
    ownerAddress: grant.account,
    sessionAddress: grant.spender,
    permissionId: grant.permissionId,
    chainId: grant.chainId,
    expiry: Math.floor(grant.expiresAt.getTime() / 1000),
    createdAt: grant.createdAt.toISOString(),
    mode: 'eip7702',
    permission: grant.permission,
  };
}

export function payerFor(t: Tenant, clients: ChainClients): Payer {
  return Eip3009EoaPayer.fromAccount(privateKeyToAccount(t.sessionKey()), clients);
}

export function topUpExecutor(t: Tenant, grant: Grant): TopUpExecutor | undefined {
  const apiKey = config().paymasterApiKey;
  if (!apiKey) return undefined;
  const session = sessionOf(grant);
  return new SessionBridge({
    apiKey,
    chainId: grant.chainId,
    logger: agentLogger,
    host: {
      loadSession: () => session,
      loadSessionKey: (): Hex => t.sessionKey(),
      configuredPaymaster: () => undefined,
      freshApiKey: async () => undefined,
    },
  });
}

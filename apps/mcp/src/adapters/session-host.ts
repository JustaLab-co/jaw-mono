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

/** An RPC or paymaster url can carry its provider key in the path or the query, so no url is ever logged. */
export const withoutUrls = (text: string) => text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, '<url>');

export const agentLogger: Logger = { warn: (message) => log('warn', { msg: withoutUrls(message) }) };

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

import { handleGetCapabilitiesRequest } from '@jaw.id/core';
import {
  Eip3009EoaPayer,
  SessionBridge,
  type ChainClients,
  type Logger,
  type Payer,
  type SessionConfig,
  type TopUpExecutor,
  within,
} from '@jaw.id/agent';
import { erc20Abi, isAddressEqual, numberToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { NATIVE_TOKEN } from '@/grants/fit';
import type { Grant, LiveGrant } from '@/grants/store';
import { publicClientFor } from '@/lib/chain';
import { errorLabel, log } from '@/lib/edge';

export const chainClients: ChainClients = { publicClient: publicClientFor };

/** An RPC or paymaster url can carry its provider key in the path or the query, so no url is ever logged. */
export const withoutUrls = (text: string) => text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, '<url>');

export const agentLogger: Logger = { warn: (message) => log('warn', { msg: withoutUrls(message) }) };

export function sessionOf(grant: LiveGrant): SessionConfig {
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

export const topUpExecutor = (t: Tenant, grant: Grant): TopUpExecutor | undefined => sessionBridge(t, grant);

const FEE_TOKENS_MS = 3_000;

/**
 * The token a custom grant's session pays its fee in: the one the wallet prefunded it with, which
 * is the grant's first ERC-20 spend, or the native coin when it spends nothing else. Undefined, so
 * USDC, when there is none, the paymaster does not take the ERC-20, or the session address holds
 * none of it: the wallet skips the prefund in some cases and the fee fails on an empty balance.
 */
export async function feeTokenOf(grant: LiveGrant): Promise<Address | undefined> {
  const { spends } = grant.permission;
  const token = spends.find((s) => !isAddressEqual(s.token as Address, NATIVE_TOKEN))?.token as Address | undefined;
  if (!token) return spends.length > 0 ? nativeFeeOf(grant) : undefined;
  const apiKey = config().paymasterApiKey;
  if (!apiKey) return undefined;
  const caps = await within(
    handleGetCapabilitiesRequest({ method: 'wallet_getCapabilities', params: [] }, apiKey, true),
    FEE_TOKENS_MS
  ).catch(unreadable('fee token capabilities'));
  const fee = caps?.[numberToHex(grant.chainId)]?.feeToken;
  if (!fee?.supported || !fee.tokens.some((f) => f.feeToken && isAddressEqual(f.address as Address, token))) {
    return undefined;
  }
  const held = await within(
    publicClientFor(grant.chainId).readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [grant.spender as Address],
    }),
    FEE_TOKENS_MS
  ).catch(unreadable('fee token balance'));
  return held !== undefined && held > 0n ? token : undefined;
}

/** Native gas needs no paymaster, so only the session's own balance decides. */
async function nativeFeeOf(grant: LiveGrant): Promise<Address | undefined> {
  const held = await within(
    publicClientFor(grant.chainId).getBalance({ address: grant.spender as Address }),
    FEE_TOKENS_MS
  ).catch(unreadable('native balance'));
  return held !== undefined && held > 0n ? NATIVE_TOKEN : undefined;
}

const unreadable = (what: string) => (err: unknown) => {
  log('warn', { msg: `${what} unreadable, the fee is paid in USDC`, error: errorLabel(err) });
  return undefined;
};

/**
 * Sends calls as the session key through the grant. Undefined without a paymaster key to pay the fee with.
 * The fee is paid in USDC unless a fee token is given, and with no paymaster when it is the native coin.
 */
export function sessionBridge(t: Tenant, grant: LiveGrant, feeToken?: Address): SessionBridge | undefined {
  const apiKey = config().paymasterApiKey;
  if (!apiKey) return undefined;
  const session = sessionOf(grant);
  const native = feeToken !== undefined && isAddressEqual(feeToken, NATIVE_TOKEN);
  return new SessionBridge({
    apiKey,
    chainId: grant.chainId,
    logger: agentLogger,
    nativeFee: native,
    paymasterContext: feeToken && !native ? { token: feeToken } : undefined,
    host: {
      loadSession: () => session,
      loadSessionKey: (): Hex => t.sessionKey(),
      configuredPaymaster: () => undefined,
      freshApiKey: async () => undefined,
    },
  });
}

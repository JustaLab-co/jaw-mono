'use client';

import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { Eyebrow, PartyRow } from '../primitives';
import { TokenIcon } from '../TokenIcon';
import { AccountAvatar } from '../AccountAvatar';
import { CopyButton } from '../CopyButton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { useAddressIdentities } from '../../hooks/useAddressIdentities';
import { ENS_ONLY } from '../../utils/addressIdentity';
import { createTokenResolver, type TokenInfo } from '../../utils/clearSigning';
import { groupNumber } from '../../utils/displayFormat';
import { formatAddress, identityKey } from '../../utils';
import { sanitizeDisplayName } from '../../utils/sanitize';
import type { Erc3009Authorization } from '../../utils/erc3009';

// "Couldn't confirm", not "isn't listed": an unreachable registry also lands here.
const UNVERIFIED_NOTE = "Couldn't confirm this is the real token. Its name and decimals come from the token contract.";

type TokenRead = { status: 'loading' } | { status: 'read'; info: TokenInfo } | { status: 'unreadable' };

/**
 * An ERC-3009 authorization shown as the payment it is. Decimals and symbol always come
 * from the token contract (the verifying contract); `verified` says whether the ERC-7730
 * registry vouches that this contract is the token it claims to be. Display only: the
 * dialog signs the typed data it was given, untouched.
 */
export function Erc3009PaymentView({
  payment,
  chainId,
  apiKey,
  mainnetRpcUrl,
  verified,
}: {
  payment: Erc3009Authorization;
  /** The chain the authorization is valid on: its domain chainId, else the connected chain. */
  chainId: number;
  apiKey?: string;
  mainnetRpcUrl: string;
  /** Registry match: true, none: false, still checking: undefined. */
  verified?: boolean;
}) {
  const [token, setToken] = useState<TokenRead>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setToken({ status: 'loading' });
    createTokenResolver(
      chainId,
      apiKey
    )(payment.token)
      .then((info) => !cancelled && setToken(info ? { status: 'read', info } : { status: 'unreadable' }))
      .catch(() => !cancelled && setToken({ status: 'unreadable' }));
    return () => {
      cancelled = true;
    };
  }, [chainId, apiKey, payment.token]);

  const identities = useAddressIdentities([{ address: payment.to, chainId }], { mainnetRpcUrl, include: ENS_ONLY });
  const payee = identities[identityKey(payment.to, chainId)];

  // The symbol is whatever the contract returns, so it is cleaned like any untrusted label.
  const symbol = token.status === 'read' ? sanitizeDisplayName(token.info.symbol, 16) : '';
  const amount =
    token.status === 'read'
      ? groupNumber(formatUnits(payment.value, token.info.decimals))
      : token.status === 'unreadable'
        ? groupNumber(payment.value.toString())
        : '…';
  // No logo (the icon service has none, or the image fails): the identicon of the token's
  // address, as the permission screen does, so each contract keeps a look of its own. Logos are
  // looked up by address, so a new contract calling itself USDC gets the identicon, not Circle's.
  const tokenLogo = (size: number, className: string) => (
    <TokenIcon
      chainId={chainId}
      address={payment.token}
      symbol={symbol}
      className={className}
      fallback={<AccountAvatar seed={payment.token} size={size} />}
    />
  );
  return (
    <div className="border-border rounded-box flex flex-col gap-3 border p-3">
      {/* The amount leads; one authorization moves one token. The network is left to the
          domain card below, so it is not repeated here. */}
      <div className="flex min-w-0 items-center gap-2">
        {tokenLogo(24, 'size-token flex-none')}
        <p className="text-foreground text-amount-lg min-w-0 break-all">{`${amount}${symbol ? ` ${symbol}` : ''}`}</p>
      </div>
      {token.status === 'unreadable' && (
        <p className="text-warning text-body-xs">
          Couldn&apos;t read this token, so the amount is in its smallest unit.
        </p>
      )}

      <PartyRow
        label="To"
        value={payee?.ensName ?? formatAddress(payment.to)}
        address={payment.to}
        avatarUrl={payee?.ensAvatar ?? undefined}
      />

      <div className="min-w-0">
        <Eyebrow>Token</Eyebrow>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          {tokenLogo(16, 'size-4 flex-none')}
          {symbol && <span className="text-foreground text-body-sm font-mono font-medium">{symbol}</span>}
          <span className="text-muted-foreground text-body-sm font-mono">{formatAddress(payment.token)}</span>
          <CopyButton value={payment.token} size={12} resetAfterMs={1500} label="Copy token address" />
          {verified === true && (
            <span className="text-positive text-body-xs flex items-center gap-1">
              <ShieldCheck className="size-3 flex-none" strokeWidth={2.4} />
              Verified
            </span>
          )}
          {verified === false && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    aria-label={UNVERIFIED_NOTE}
                    className="text-warning text-body-xs flex cursor-help items-center gap-1"
                  >
                    <TriangleAlert className="size-3 flex-none" strokeWidth={2} />
                    Unverified
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[240px]">{UNVERIFIED_NOTE}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    </div>
  );
}

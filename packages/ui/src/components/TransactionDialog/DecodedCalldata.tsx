import { useState, useEffect, useRef, useMemo } from 'react';
import type { Hex } from 'viem';
import type { DecodeResult } from '../../hooks/useDecodedCalldata';
import { Spinner } from '../ui/spinner';
import { TriangleAlert } from 'lucide-react';
import { reverseResolveWithAvatars, formatAddress, getChainLabel, identityKey } from '../../utils';
import { isUnlimitedAmount } from '../../utils/displayFormat';
import { computeCalldataDigest } from '../../utils/erc8213';
import { IdentityAvatar } from '../IdentityAvatar';
import { TokenIcon } from '../TokenIcon';
import { DigestRow } from '../VerificationDigest';
import { ClearSignedView } from './ClearSignedView';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * True only for the exact ERC-20 `approve(address,uint256)` shape. "Unlimited" is a claim about
 * an allowance, so it must never leak onto another function taking a large uint256.
 */
export function isErc20Approve(decoded: DecodeResult['decoded']): boolean {
  return (
    decoded?.functionName === 'approve' &&
    decoded.params.length === 2 &&
    decoded.params[0]?.type === 'address' &&
    decoded.params[1]?.type === 'uint256'
  );
}

/**
 * ERC-8213 Calldata Digest, collapsed behind a disclosure like the raw calldata
 * view. Shown only for non-empty calldata; the spec omits the digest when
 * calldata is empty (`0x`/undefined).
 */
const CalldataDigest = ({ data }: { data: string }) => {
  const digest = useMemo(() => {
    if (!data || data === '0x') return null;
    try {
      return computeCalldataDigest(data as Hex);
    } catch {
      return null;
    }
  }, [data]);

  if (!digest) return null;
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer">Show calldata digest</summary>
      <div className="mt-2">
        <DigestRow label="Calldata Digest" value={digest} />
      </div>
    </details>
  );
};

/** Merge parent-resolved and locally-resolved maps, normalizing all keys to lowercase. */
function mergeLowercased(
  parent: Record<string, string> | undefined,
  local: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent ?? {})) out[key.toLowerCase()] = value;
  for (const [key, value] of Object.entries(local)) out[key.toLowerCase()] = value;
  return out;
}

/** ERC-7730 intent, else the decoded function name, else the caller's fallback. */
export function callLabel(decode: DecodeResult, fallback: string): string {
  if (decode.clearSigned?.intent) return decode.clearSigned.intent;
  if (decode.decoded?.functionName) return `${decode.decoded.functionName}()`;
  return fallback;
}

/** The same action as a headline: intent verbatim, else the function name un-camel-cased ("Swap Exact Tokens"). */
export function callTitle(decode: DecodeResult): string | null {
  if (decode.clearSigned?.intent) return decode.clearSigned.intent;
  const fn = decode.decoded?.functionName;
  if (!fn) return null;
  return fn.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

export interface DecodedCalldataProps {
  to: string;
  data: string;
  chainId: number;
  apiKey?: string;
  resolvedAddresses?: Record<string, string>;
  resolvedAvatars?: Record<string, string>;
  mainnetRpcUrl?: string;
}

export const DecodedCalldataView = ({
  data,
  chainId,
  resolvedAddresses,
  resolvedAvatars,
  mainnetRpcUrl,
  decode,
}: DecodedCalldataProps & { decode: DecodeResult }) => {
  const { clearSigned, decoded, isLoading } = decode;
  const [localResolved, setLocalResolved] = useState<Record<string, string>>({});
  const [localAvatars, setLocalAvatars] = useState<Record<string, string>>({});
  const attemptedRef = useRef<Set<string>>(new Set());

  // Reset local state when decoded data changes identity (new transaction)
  const decodedIdRef = useRef(decoded);
  useEffect(() => {
    if (decodedIdRef.current !== decoded) {
      decodedIdRef.current = decoded;
      setLocalResolved({});
      setLocalAvatars({});
      attemptedRef.current = new Set();
    }
  }, [decoded]);

  const allResolved = useMemo(
    () => mergeLowercased(resolvedAddresses, localResolved),
    [resolvedAddresses, localResolved]
  );
  const allAvatars = useMemo(() => mergeLowercased(resolvedAvatars, localAvatars), [resolvedAvatars, localAvatars]);

  // Keep a ref to allResolved so the effect can read it without re-triggering
  const allResolvedRef = useRef(allResolved);
  allResolvedRef.current = allResolved;

  // Resolve address params that aren't already resolved
  useEffect(() => {
    if (!decoded || !mainnetRpcUrl) return;

    const currentResolved = allResolvedRef.current;
    const addressParams = decoded.params
      .filter((p) => p.type === 'address' && p.rawValue)
      .map((p) => p.rawValue!)
      .filter((addr) => {
        const lower = addr.toLowerCase();
        return lower !== ZERO_ADDRESS && !currentResolved[lower] && !attemptedRef.current.has(lower);
      });

    // Deduplicate
    const unique = [...new Set(addressParams)];
    if (unique.length === 0) return;

    // Mark as attempted immediately to prevent re-fetching. An attempt only "counts"
    // once it lands — see the cleanup, which un-marks anything still in flight.
    unique.forEach((addr) => attemptedRef.current.add(addr.toLowerCase()));
    const unmark = () => unique.forEach((addr) => attemptedRef.current.delete(addr.toLowerCase()));

    let cancelled = false;
    // Set once this run's result has landed. After that the attempt "counts" — including
    // for addresses that resolved to no name — so the cleanup must leave the marks alone
    // or every unresolvable address gets re-queried on the next run.
    let wrote = false;
    reverseResolveWithAvatars(
      unique.map((address) => ({ address, chainId })),
      mainnetRpcUrl
    )
      .then(async (resolved) => {
        if (cancelled) return;
        const label = await getChainLabel(chainId, mainnetRpcUrl);
        if (cancelled) return;
        wrote = true;
        const next: Record<string, string> = {};
        const avatarByAddress: Record<string, string> = {};
        for (const address of unique) {
          const identity = resolved[identityKey(address, chainId)];
          if (!identity) continue;
          next[address.toLowerCase()] = label ? `${identity.name}@${label}` : identity.name;
          if (identity.avatar) avatarByAddress[address.toLowerCase()] = identity.avatar;
        }
        if (Object.keys(next).length > 0) {
          setLocalResolved((prev) => ({ ...prev, ...next }));
        }
        if (Object.keys(avatarByAddress).length > 0) {
          setLocalAvatars((prev) => ({ ...prev, ...avatarByAddress }));
        }
      })
      .catch(unmark);
    return () => {
      cancelled = true;
      // If this run never wrote its result, its "attempted" marks must not outlive it —
      // otherwise the next run (a StrictMode re-invoke, or a chainId change) filters
      // every address out as already-tried and resolution is blocked for good.
      if (!wrote) unmark();
    };
  }, [decoded, mainnetRpcUrl, chainId]);

  // Clear-signing hit: render the formatted view, with raw whatsabi details collapsed underneath.
  if (clearSigned && clearSigned.rows.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        <ClearSignedView display={clearSigned} chainId={chainId} mainnetRpcUrl={mainnetRpcUrl} />
        <details className="text-xs">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer">Show raw details</summary>
          <div className="mt-1 flex flex-col gap-2">
            {decoded ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-foreground bg-primary/10 rounded-xs px-2 py-0.5 text-xs font-semibold">
                    {decoded.functionName}
                  </span>
                  <span className="text-muted-foreground font-mono text-xs">{decoded.signature}</span>
                </div>
                <div className="bg-secondary rounded-chip flex flex-col gap-1 p-2">
                  {decoded.params.length === 0 && <p className="text-muted-foreground text-xs">No parameters</p>}
                  {decoded.params.map((param, i) => (
                    <div key={i} className="flex flex-col gap-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-muted-foreground text-xs font-semibold">{param.name}</span>
                        <span className="text-muted-foreground/60 text-body-xs font-mono">{param.type}</span>
                      </div>
                      <p className="text-foreground break-all font-mono text-xs leading-normal">{param.value}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            <div className="bg-secondary rounded-chip max-h-[20vh] overflow-y-auto p-2">
              <p className="text-foreground break-all font-mono text-xs leading-normal">{data}</p>
            </div>
          </div>
        </details>
        <CalldataDigest data={data} />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Spinner className="size-3" />
          <span className="text-muted-foreground text-xs">Decoding calldata...</span>
        </div>
        <div className="bg-secondary rounded-chip max-h-[40vh] overflow-y-auto p-2 opacity-50">
          <p className="text-foreground break-all font-mono text-xs font-semibold leading-normal">{data}</p>
        </div>
      </div>
    );
  }

  if (!decoded) {
    return (
      <div className="flex flex-col gap-2">
        <div className="bg-secondary rounded-chip max-h-[40vh] overflow-y-auto p-2">
          <p className="text-foreground break-all font-mono text-xs font-semibold leading-normal">{data}</p>
        </div>
        <CalldataDigest data={data} />
      </div>
    );
  }

  const approveShape = isErc20Approve(decoded);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-foreground bg-primary/10 rounded-xs px-2 py-0.5 text-xs font-semibold">
          {decoded.functionName}
        </span>
        <span className="text-muted-foreground font-mono text-xs">{decoded.signature}</span>
      </div>

      {/* Always boxed, even with no params — a zero-arg call would otherwise render as loose text. */}
      <div className="bg-secondary rounded-chip flex flex-col gap-1 p-2">
        {decoded.params.length === 0 && <p className="text-muted-foreground text-xs">No parameters</p>}
        {decoded.params.map((param, i) => {
          const resolvedName = param.rawValue ? allResolved[param.rawValue.toLowerCase()] : undefined;
          const resolvedAvatar = param.rawValue ? allAvatars[param.rawValue.toLowerCase()] : undefined;
          const unlimitedApproval = approveShape && i === 1 && isUnlimitedAmount(param.value);
          return (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-muted-foreground text-xs font-semibold">{param.name}</span>
                <span className="text-muted-foreground/60 text-body-xs font-mono">{param.type}</span>
              </div>
              <div className="flex flex-row items-center gap-1">
                {resolvedAvatar && <IdentityAvatar src={resolvedAvatar} fallback={null} />}
                {unlimitedApproval ? (
                  <p className="text-warning flex items-center gap-1.5 font-mono text-xs font-semibold leading-normal">
                    <TriangleAlert className="size-3.5 flex-none" strokeWidth={2} />
                    Unlimited
                  </p>
                ) : (
                  <p className="text-foreground break-all font-mono text-xs leading-normal">
                    {resolvedName ? `${resolvedName} (${formatAddress(param.rawValue!)})` : param.value}
                  </p>
                )}
                {param.rawValue && param.rawValue.toLowerCase() !== ZERO_ADDRESS && !resolvedAvatar && (
                  // Address params with no ENS avatar: known token contracts get their logo after the address.
                  // The zero address is excluded — tokenIconUrl maps it to the native icon, wrong for calldata params.
                  <TokenIcon chainId={chainId} address={param.rawValue} className="ml-1 size-4" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <details className="text-xs">
        <summary className="text-muted-foreground hover:text-foreground cursor-pointer">Raw calldata</summary>
        <div className="bg-secondary rounded-chip mt-1 max-h-[20vh] overflow-y-auto p-2">
          <p className="text-foreground break-all font-mono text-xs leading-normal">{data}</p>
        </div>
      </details>

      <CalldataDigest data={data} />
    </div>
  );
};

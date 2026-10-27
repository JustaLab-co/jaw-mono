import { useMemo } from 'react';
import type { Hex } from 'viem';
import type { DecodeResult } from '../../hooks/useDecodedCalldata';
import type { AllowanceFlag } from '../../hooks/useAllowanceFlags';
import { Spinner } from '../ui/spinner';
import { TriangleAlert } from 'lucide-react';
import { useAddressIdentities } from '../../hooks/useAddressIdentities';
import { formatAddress, identityKey } from '../../utils';
import { ENS_ONLY } from '../../utils/addressIdentity';
import { isUnlimitedAmount } from '../../utils/displayFormat';
import { computeCalldataDigest } from '../../utils/erc8213';
import { IdentityAvatar } from '../IdentityAvatar';
import { TokenIcon } from '../TokenIcon';
import { DigestRow } from '../VerificationDigest';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { ClearSignedView } from './ClearSignedView';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The amber allowance warning: "Unlimited", or "All tokens" for a whole collection. */
export const AllowanceFlagText = ({ flag }: { flag: AllowanceFlag }) => (
  <span className="text-warning flex flex-none items-center gap-1.5 font-mono text-xs font-semibold leading-normal">
    <TriangleAlert className="size-3.5 flex-none" strokeWidth={2} />
    {flag.label}
  </span>
);

const FLAG_NOTES: Record<AllowanceFlag['label'], string> = {
  Unlimited: 'Lets the spender take any amount of this token, now or later.',
  'All tokens': 'Lets the operator move every token in this collection, now or later.',
};

/**
 * The warning with what it allows, on hover or keyboard focus. The visible word stays its name and
 * the note is its description. Never inside a header: that is a button already.
 */
const NotedAllowanceFlag = ({ flag }: { flag: AllowanceFlag }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span
        tabIndex={0}
        className="focus-visible:ring-ring/50 flex-none cursor-help rounded-sm outline-none focus-visible:ring-[3px]"
      >
        <AllowanceFlagText flag={flag} />
      </span>
    </TooltipTrigger>
    <TooltipContent>{FLAG_NOTES[flag.label]}</TooltipContent>
  </Tooltip>
);

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

/**
 * The flag, only for a call the lookup could read. While it loads, or when it cannot read the
 * call (the contract may not even have that function), the screen does not claim an allowance.
 */
export function readableFlag(decode: DecodeResult, flag: AllowanceFlag | null): AllowanceFlag | null {
  const readable = !!decode.decoded || (decode.clearSigned?.rows.length ?? 0) > 0;
  return readable ? flag : null;
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
  mainnetRpcUrl: string;
}

export const DecodedCalldataView = ({
  data,
  chainId,
  mainnetRpcUrl,
  decode,
  allowanceFlag,
}: DecodedCalldataProps & {
  decode: DecodeResult;
  /** From the local allowance decode; shown only once the lookup has read the call. */
  allowanceFlag: AllowanceFlag | null;
}) => {
  const { clearSigned, decoded, isLoading } = decode;

  // Address params, named on this call's chain. The zero address is a sentinel, not a party.
  const paramAddresses = (decoded?.params ?? [])
    .filter((p) => p.type === 'address' && p.rawValue && p.rawValue.toLowerCase() !== ZERO_ADDRESS)
    .map((p) => ({ address: p.rawValue as string, chainId }));
  const identities = useAddressIdentities(paramAddresses, { mainnetRpcUrl, include: ENS_ONLY });

  // Clear-signing hit: render the formatted view, with raw whatsabi details collapsed underneath.
  if (clearSigned && clearSigned.rows.length > 0) {
    // The clear-signed view already says "Unlimited" on a max-uint amount; the flag goes on top
    // unless that amount is the one it stands for.
    const flaggedAmount = allowanceFlag?.amount?.toString();
    const flaggedInView =
      flaggedAmount !== undefined &&
      isUnlimitedAmount(flaggedAmount) &&
      clearSigned.rows.some(
        (row) => (row.kind === 'tokenAmount' || row.kind === 'amount') && row.rawValue === flaggedAmount
      );
    return (
      <div className="flex flex-col gap-2">
        {allowanceFlag && !flaggedInView && <NotedAllowanceFlag flag={allowanceFlag} />}
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

  // The flag takes the place of an amount or an approved/allowed flag only. If the lookup read the
  // call with another ABI and that argument is something else, the value stays and the flag goes on top.
  const flagArg = allowanceFlag ? decoded.params[allowanceFlag.argIndex] : undefined;
  const flagInPlace = !!flagArg && /^(uint\d*|bool)$/.test(flagArg.type);
  const flagOnTop = allowanceFlag && !flagInPlace ? allowanceFlag : null;

  return (
    <div className="flex flex-col gap-2">
      {flagOnTop && <NotedAllowanceFlag flag={flagOnTop} />}
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
          const identity = param.rawValue ? identities[identityKey(param.rawValue, chainId)] : undefined;
          const resolvedName = identity?.ensName;
          const resolvedAvatar = identity?.ensAvatar;
          const argFlag = flagInPlace && allowanceFlag?.argIndex === i ? allowanceFlag : null;
          return (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-muted-foreground text-xs font-semibold">{param.name}</span>
                <span className="text-muted-foreground/60 text-body-xs font-mono">{param.type}</span>
              </div>
              <div className="flex flex-row items-center gap-1">
                {resolvedAvatar && <IdentityAvatar src={resolvedAvatar} fallback={null} />}
                {argFlag ? (
                  <NotedAllowanceFlag flag={argFlag} />
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

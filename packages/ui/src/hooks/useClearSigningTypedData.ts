import { useEffect, useMemo, useState } from 'react';
import {
  applyFormat,
  createTokenResolver,
  getDefaultDescriptorSource,
  getNativeDecimals,
  getNativeSymbol,
  normalizeChainId,
  resolveEip712Descriptor,
  type ClearSigningDisplay,
} from '../utils/clearSigning';

interface TypedData {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

interface UseClearSigningTypedDataResult {
  display: ClearSigningDisplay | null;
  isLoading: boolean;
  chainId: number;
}

/**
 * Resolve an ERC-7730 descriptor for `(chainId, verifyingContract, primaryType)`
 * and produce a ClearSigningDisplay over the typed-data message.
 * Returns `display: null` when no descriptor matches.
 */
export function useClearSigningTypedData(
  typedDataJson: string | undefined,
  chainId: number,
  apiKey?: string
): UseClearSigningTypedDataResult {
  const [display, setDisplay] = useState<ClearSigningDisplay | null>(null);
  // Starts true when there is something to resolve, so a caller never reads "no match"
  // in the render before the lookup has begun.
  const [isLoading, setIsLoading] = useState(() => !!typedDataJson);

  const parsed = useMemo(() => {
    if (!typedDataJson) return null;
    try {
      return JSON.parse(typedDataJson) as TypedData;
    } catch {
      return null;
    }
  }, [typedDataJson]);

  const effectiveChainId = normalizeChainId(parsed?.domain?.chainId) ?? chainId;

  useEffect(() => {
    if (!parsed) {
      setDisplay(null);
      setIsLoading(false);
      return;
    }

    const verifyingContract = parsed.domain?.verifyingContract as string | undefined;
    const primaryType = parsed.primaryType;
    if (!verifyingContract || !primaryType) {
      setDisplay(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const match = await resolveEip712Descriptor(
          getDefaultDescriptorSource(),
          effectiveChainId,
          verifyingContract,
          primaryType,
          parsed.types,
          parsed.domain
        );
        if (cancelled) return;
        if (!match) {
          setDisplay(null);
          setIsLoading(false);
          return;
        }

        const result = await applyFormat(match.descriptor, match.format, {
          args: { ...parsed.message },
          // Spread parsed.domain first so the hook's normalized values (lower-cased
          // verifyingContract, numeric chainId) win when a dApp ships a differently-cased
          // address or a hex chainId. Renderer reads from this; we don't want descriptor
          // rows to surface dApp-controlled spelling.
          // `to` is ERC-7730's EIP-712 container value: `@.to` is the verifying contract.
          // Descriptors such as Circle's ERC-3009 and ERC-2612 permits name their token
          // with `tokenPath: "@.to"`, so without it their amounts render raw.
          tx: {
            ...parsed.domain,
            chainId: effectiveChainId,
            verifyingContract: verifyingContract.toLowerCase(),
            to: verifyingContract.toLowerCase(),
          },
          chainId: effectiveChainId,
          nativeSymbol: getNativeSymbol(effectiveChainId),
          nativeDecimals: getNativeDecimals(effectiveChainId),
          resolveToken: createTokenResolver(effectiveChainId, apiKey),
        });

        if (!cancelled) {
          // applyFormat → null means a mustMatch violation; surface as "no descriptor"
          // so the dialog falls back to raw decode.
          setDisplay(result);
          setIsLoading(false);
        }
      } catch (err) {
        console.debug('[useClearSigningTypedData] resolve failed:', err);
        if (!cancelled) {
          setDisplay(null);
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [parsed, effectiveChainId, apiKey]);

  return { display, isLoading, chainId: effectiveChainId };
}

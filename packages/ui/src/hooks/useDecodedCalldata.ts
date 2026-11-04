import { useEffect, useState } from 'react';
import type { Abi, Hex } from 'viem';
import { getPublicClient, jawRpcUrl } from '../utils/publicClient';
import {
  applyFormat,
  createTokenResolver,
  decodeCalldataWithSignature,
  getDefaultDescriptorSource,
  getNativeDecimals,
  getNativeSymbol,
  resolveCalldataDescriptor,
  type ClearSigningDisplay,
} from '../utils/clearSigning';
import { decodeWithAbi } from '../utils/decodeWithAbi';

export interface DecodedParam {
  name: string;
  type: string;
  value: string;
  rawValue?: string;
}

export interface DecodedCalldata {
  functionName: string;
  signature: string;
  params: DecodedParam[];
  /** Bytes after the last argument (a builder-code or referral suffix), when the call has any. */
  trailing?: Hex;
  /** The ABI decodes the calldata but does not re-encode to it, so the suffix cannot be told apart. */
  nonCanonical?: boolean;
  /** On a non-canonical decode, how many bytes the calldata runs past what its arguments re-encode to. */
  extraBytes?: number;
}

/**
 * Result of attempting to decode calldata.
 * - `clearSigned` is set when the contract has an ERC-7730 descriptor in the public registry.
 * - `decoded` is set when whatsabi's bytecode-based ABI extraction succeeds.
 * Both may be set: the clear-signed view renders on top, the raw view sits under "Show raw details".
 * Neither may be set if the contract is unknown to both pipelines.
 */
export interface DecodeResult {
  clearSigned: ClearSigningDisplay | null;
  decoded: DecodedCalldata | null;
  isLoading: boolean;
}

const abiCache = new Map<string, Abi>();
const abiInflight = new Map<string, Promise<Abi>>();

async function fetchAbi(address: string, rpcUrl: string, chainId: number): Promise<Abi> {
  // Keyed by chain: with `abiLoader: false` whatsabi derives the ABI from that chain's
  // bytecode, so the same address on two chains is two different contracts.
  const key = `${chainId}:${address.toLowerCase()}`;
  const cached = abiCache.get(key);
  if (cached) return cached;

  const existing = abiInflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    // Loaded on demand, and nothing needs it for the first paint — a native send never
    // decodes at all, and a batch's calldata accordions start collapsed. Measured on
    // `nx build @jaw.id/ui`: it splits out as a 60.09 kB chunk (16.73 kB gzip) and the
    // entry drops from 655.57 kB to 603.90 kB (192.69 → 178.31 kB gzip). Keeping it out
    // of the entry chunk matters most for the popup transport, which cannot prewarm.
    //
    // `chainId` below is threaded through for the shared-client dedup, not for batching:
    // whatsabi drives a ViemProvider that calls `transport.request` directly, bypassing
    // viem's action layer and its multicall scheduler entirely.
    const { whatsabi } = await import('@shazow/whatsabi');
    const client = getPublicClient(chainId, rpcUrl);
    const result = await whatsabi.autoload(address, {
      provider: client,
      followProxies: true,
      abiLoader: false,
      signatureLookup: new whatsabi.loaders.OpenChainSignatureLookup(),
    });
    const abi = result.abi as Abi;
    abiCache.set(key, abi);
    return abi;
  })();

  abiInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    abiInflight.delete(key);
  }
}

async function rawDecode(to: string, data: string, rpcUrl: string, chainId: number): Promise<DecodedCalldata | null> {
  try {
    return decodeWithAbi(await fetchAbi(to, rpcUrl, chainId), data as Hex);
  } catch (err) {
    console.debug('[useDecodedCalldata] raw decode failed:', err);
    return null;
  }
}

async function clearSignedDecode(
  to: string,
  data: string,
  chainId: number,
  apiKey: string | undefined
): Promise<ClearSigningDisplay | null> {
  const match = await resolveCalldataDescriptor(getDefaultDescriptorSource(), chainId, to, data);
  if (!match) return null;
  const decoded = decodeCalldataWithSignature(match.formatKey, data);
  if (!decoded) return null;
  return applyFormat(match.descriptor, match.format, {
    args: decoded.args,
    tx: { to: to.toLowerCase(), chainId },
    chainId,
    nativeSymbol: getNativeSymbol(chainId),
    nativeDecimals: getNativeDecimals(chainId),
    resolveToken: createTokenResolver(chainId, apiKey),
  });
}

const EMPTY: DecodeResult = { clearSigned: null, decoded: null, isLoading: false };
const LOADING: DecodeResult = { clearSigned: null, decoded: null, isLoading: true };

export function useDecodedCalldata(
  to: string | undefined,
  data: string | undefined,
  chainId: number,
  apiKey?: string
): DecodeResult {
  const [result, setResult] = useState<DecodeResult>(EMPTY);

  useEffect(() => {
    if (!to || !data || data === '0x' || data.length < 10) {
      setResult(EMPTY);
      return;
    }

    let cancelled = false;
    setResult(LOADING);

    const rpcUrl = jawRpcUrl(chainId, apiKey);

    // Both pipelines run in parallel so the "Show raw details" disclosure is instant when opened.
    // Only the clear-signed side can reject (applyFormat rethrows unexpected formatter errors);
    // swallow it here so a bad descriptor never discards a successful raw decode.
    Promise.all([
      clearSignedDecode(to, data, chainId, apiKey).catch((err) => {
        console.debug('[useDecodedCalldata] clear-signed decode failed:', err);
        return null;
      }),
      rawDecode(to, data, rpcUrl, chainId),
    ])
      .then(([clearSigned, decoded]) => {
        if (!cancelled) setResult({ clearSigned, decoded, isLoading: false });
      })
      .catch((err) => {
        console.debug('[useDecodedCalldata] decode failed:', err);
        if (!cancelled) setResult(EMPTY);
      });

    return () => {
      cancelled = true;
    };
  }, [to, data, chainId, apiKey]);

  return result;
}

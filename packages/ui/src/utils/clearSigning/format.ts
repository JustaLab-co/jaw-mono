// ============================================================================
//  Formatter
// ----------------------------------------------------------------------------
// Apply a matched DescriptorFormat to decoded args / tx envelope and produce
// the DisplayRow[] the UI renders, plus the shared on-chain ERC-20 token
// resolver + native-coin helpers.
//
// This is the ONLY clear-signing module that depends on @jaw.id/core (for
// SUPPORTED_CHAINS, and transitively via the shared public client). The
// resolvers (eip712/calldata) and the
// includes-merge (source) stay core-free so they're unit-testable in isolation.
//
// Supported field formats (v1):
//   raw          → render verbatim
//   addressName  → render as address (UI handles ENS reverse-resolve)
//   tokenAmount  → decimals + symbol from `params.tokenPath` (on-chain read)
//   amount       → native coin amount with chain symbol
//   date         → timestamp → locale string (blockheight encoding falls back to raw)
//   unit         → params.decimals + params.base + params.prefix
//   nftName / duration / enum / calldata → fall through to raw
// ============================================================================

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  formatUnits,
  isAddress,
  parseAbiItem,
} from 'viem';
import { SUPPORTED_CHAINS } from '@jaw.id/core';
import { getJawPublicClient } from '../publicClient';
import { resolvePath } from './path';
import { isUnlimitedAmount } from '../displayFormat';
import type {
  ClearSigningDisplay,
  Descriptor,
  DescriptorField,
  DescriptorFormat,
  DisplayRow,
  FormatterContext,
  TokenInfo,
} from './types';

const NATIVE_SENTINELS = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

const isNativeSentinel = (addr: string | undefined) => !!addr && NATIVE_SENTINELS.has(addr.toLowerCase());

function resolveRef(descriptor: Descriptor, ref: string): Partial<DescriptorField> | null {
  // `$.display.definitions.sendAmount` → walk the descriptor object.
  const segments = ref.replace(/^\$\./, '').split('.');
  let cur: unknown = descriptor;
  for (const s of segments) {
    if (cur && typeof cur === 'object' && s in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[s];
    } else {
      return null;
    }
  }
  return (cur as Partial<DescriptorField>) ?? null;
}

function mergeField(descriptor: Descriptor, field: DescriptorField): DescriptorField {
  if (!field.$ref) return field;
  const def = resolveRef(descriptor, field.$ref);
  if (!def) return field;
  return {
    ...def,
    ...field,
    params: { ...(def.params ?? {}), ...(field.params ?? {}) },
  } as DescriptorField;
}

function defaultLabel(field: DescriptorField): string {
  if (field.label) return field.label;
  const segs = field.path.split('.').filter((s) => !s.startsWith('['));
  const last = segs[segs.length - 1] ?? field.path;
  return last
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(asString).join(', ')}]`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toBigInt(value: unknown): bigint | null {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.length > 0) return BigInt(value);
  } catch {
    /* ignore */
  }
  return null;
}

function rawRow(label: string, value: unknown): DisplayRow {
  const v = asString(value);
  const looksLikeAddress = typeof value === 'string' && isAddress(value);
  return {
    label,
    value: v,
    kind: looksLikeAddress ? 'address' : 'raw',
    rawValue: looksLikeAddress ? (value as string) : undefined,
  };
}

/**
 * Thrown when a field's `mustMatch` rule fails. ERC-7730 treats this as a vetting
 * failure (not a display hint) — the descriptor's author scoped their labels to a
 * specific value set and we observed something outside it. Caught in `applyFormat`
 * to abort clear-signing for the whole transaction; the UI then falls back to raw
 * decode rather than presenting the descriptor's labels for an interaction the
 * author didn't vouch for.
 */
class MustMatchViolation extends Error {
  constructor(public readonly field: string) {
    super(`mustMatch violation on field ${field}`);
    this.name = 'MustMatchViolation';
  }
}

/**
 * Thrown when a descriptor field resolves to a struct/array where the template
 * expects a scalar (e.g. Permit2 `PermitBatch.details` is a `PermitDetails[]`, but
 * a flat "Amount allowance" slot can't represent it). Caught in `applyFormat` to
 * abandon the descriptor and fall back to the raw tree — never stringify a struct
 * into a template slot and pass it off as a legible "Amount"/"Expires".
 */
class MappingFailure extends Error {
  constructor(public readonly field: string) {
    super(`descriptor field ${field} mapped to a non-scalar value`);
    this.name = 'MappingFailure';
  }
}

/** Scalars are the only thing a flat display row can honestly render; arrays/objects are a mapping failure. */
function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== 'object';
}

/**
 * Case-insensitive (for hex addresses) membership check used by `mustMatch` / `ifNotIn`.
 * Values can be addresses, enum strings, or numeric strings; we normalize both sides to
 * lowercase so descriptor authors don't have to pick a casing convention.
 */
function valueInList(value: unknown, list: string[]): boolean {
  const v = asString(value).toLowerCase();
  return list.some((item) => item.toLowerCase() === v);
}

async function formatField(
  descriptor: Descriptor,
  rawField: DescriptorField,
  ctx: FormatterContext
): Promise<DisplayRow | null> {
  const field = mergeField(descriptor, rawField);

  if (field.visible === false || field.visible === 'never') return null;

  const label = defaultLabel(field);
  const value = resolvePath(field.path, ctx);
  if (value === undefined) return null;

  // The path pointed at a struct/array (e.g. an unindexed `PermitBatch.details`).
  // A flat row can't represent it — abandon the descriptor and fall back to the tree.
  if (!isScalar(value)) throw new MappingFailure(field.path);

  // ERC-7730 MUST: `mustMatch` violation invalidates the descriptor for this tx.
  // Thrown — `applyFormat` catches and aborts so the UI can fall back to raw decode.
  if (field.mustMatch && field.mustMatch.length > 0 && !valueInList(value, field.mustMatch)) {
    throw new MustMatchViolation(field.path);
  }

  // ERC-7730 visibility filter: `ifNotIn` shows the row only when value is NOT in list.
  if (field.ifNotIn && field.ifNotIn.length > 0 && valueInList(value, field.ifNotIn)) return null;

  switch (field.format ?? 'raw') {
    case 'addressName': {
      if (typeof value !== 'string' || !isAddress(value)) return rawRow(label, value);
      return { label, value, kind: 'address', rawValue: value };
    }

    case 'tokenAmount': {
      const amount = toBigInt(value);
      // A max-uint approval (uint256/uint160 max) is "unlimited" — render it that way here
      // too, not as a raw 78-digit number (the raw tree already does this).
      const unlimited = amount !== null && isUnlimitedAmount(amount);
      let tokenAddr: string | undefined;
      if (field.params?.tokenPath) {
        const tokenVal = resolvePath(field.params.tokenPath, ctx);
        if (typeof tokenVal === 'string') tokenAddr = tokenVal;
      }

      if (isNativeSentinel(tokenAddr) || (!tokenAddr && field.params?.nativeCurrencyAddress)) {
        const formatted = unlimited
          ? 'Unlimited'
          : amount !== null
            ? formatUnits(amount, ctx.nativeDecimals ?? 18)
            : asString(value);
        return {
          label,
          value: formatted,
          kind: 'tokenAmount',
          symbol: ctx.nativeSymbol ?? 'ETH',
          rawValue: amount?.toString(),
        };
      }

      // Permit-style default: an unresolved tokenPath denominates in the verifyingContract
      // (the permitted token). Gated on `metadata.token` so a non-token contract that
      // implements decimals()/symbol() can't get a convincing-but-wrong denomination.
      if (!tokenAddr && descriptor.metadata?.token && typeof ctx.tx?.verifyingContract === 'string') {
        tokenAddr = ctx.tx.verifyingContract;
      }

      let info: TokenInfo | null = null;
      if (tokenAddr && ctx.resolveToken) {
        try {
          info = await ctx.resolveToken(tokenAddr);
        } catch {
          info = null;
        }
      }

      if (info && amount !== null) {
        return {
          label,
          value: unlimited ? 'Unlimited' : formatUnits(amount, info.decimals),
          kind: 'tokenAmount',
          symbol: info.symbol,
          rawValue: amount.toString(),
          tokenAddress: tokenAddr,
        };
      }

      // Token denomination unknown (decimals/symbol read failed or token addr missing).
      // Render the raw wei as kind='raw' with no symbol — never pretend we know the unit, since
      // a malicious token could revert decimals() and have the wallet display "1e18" as a tidy
      // "amount" with a token-icon styling. Exception: a max-uint "Unlimited" has no unit to
      // fake, so keep kind='tokenAmount' — it earns the amber warning treatment in the UI.
      return {
        label,
        value: unlimited ? 'Unlimited' : amount !== null ? amount.toString() : asString(value),
        kind: unlimited ? 'tokenAmount' : 'raw',
        rawValue: amount?.toString(),
      };
    }

    case 'amount': {
      const amount = toBigInt(value);
      const formatted = amount !== null ? formatUnits(amount, ctx.nativeDecimals ?? 18) : asString(value);
      return {
        label,
        value: formatted,
        kind: 'amount',
        symbol: ctx.nativeSymbol ?? 'ETH',
        rawValue: amount?.toString(),
      };
    }

    case 'date': {
      const n = toBigInt(value);
      if (n === null || field.params?.encoding === 'blockheight') return rawRow(label, value);
      const date = new Date(Number(n) * 1000);
      if (Number.isNaN(date.getTime())) return rawRow(label, value);
      return { label, value: date.toLocaleString(), kind: 'date', rawValue: n.toString() };
    }

    case 'unit': {
      const n = toBigInt(value);
      if (n === null) return rawRow(label, value);
      const decimals = field.params?.decimals ?? 0;
      const base = typeof field.params?.base === 'string' ? field.params.base : '';
      const prefix = typeof field.params?.prefix === 'string' ? field.params.prefix : '';
      const text = decimals > 0 ? formatUnits(n, decimals) : n.toString();
      return {
        label,
        value: `${prefix}${text}${base ? ` ${base}` : ''}`,
        kind: 'unit',
        rawValue: n.toString(),
      };
    }

    default:
      return rawRow(label, value);
  }
}

function getIntent(format: DescriptorFormat): string | undefined {
  if (typeof format.intent === 'string') return format.intent;
  if (format.intent && typeof format.intent === 'object') {
    const first = Object.values(format.intent)[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

export async function applyFormat(
  descriptor: Descriptor,
  format: DescriptorFormat,
  ctx: FormatterContext
): Promise<ClearSigningDisplay | null> {
  const rows: DisplayRow[] = [];
  try {
    for (const f of format.fields ?? []) {
      // v1: array-iteration fields render as raw (the underlying array literal) —
      // but only for scalar arrays; an array of structs can't collapse to one row.
      if (f.path.endsWith('.[]')) {
        const val = resolvePath(f.path, ctx);
        if (Array.isArray(val) && val.some((el) => !isScalar(el))) throw new MappingFailure(f.path);
        rows.push(rawRow(defaultLabel(mergeField(descriptor, f)), val));
        continue;
      }
      const row = await formatField(descriptor, f, ctx);
      if (row) rows.push(row);
    }
  } catch (err) {
    // A `mustMatch` violation (author didn't vouch for this value set) or a mapping
    // failure (struct/array where a scalar was expected) invalidates the descriptor.
    // Return null so the hook falls back to the raw tree instead of a misleading card.
    if (err instanceof MustMatchViolation || err instanceof MappingFailure) return null;
    throw err;
  }

  const meta = descriptor.metadata ?? {};
  return {
    intent: getIntent(format),
    contractName: meta.contractName ?? descriptor.context?.$id,
    owner: meta.owner ?? meta.info?.legalName,
    ownerUrl: meta.info?.url,
    rows,
  };
}

// ============================================================================
//  Shared ERC-20 token resolver
// ----------------------------------------------------------------------------
// Used by useDecodedCalldata (clear-signing branch) and useClearSigningTypedData
// to fetch `decimals()` + `symbol()` from chain. Module-level cache shared across hooks.
// ============================================================================

const tokenCache = new Map<string, TokenInfo | null>();

/** The EIP-3668 `OffchainLookup` selector, as it arrives in a revert this client will not follow. */
const OFFCHAIN_LOOKUP_SELECTOR = '0x556f1830';

/**
 * Whether a failed `decimals()`/`symbol()` read proves the address is not an ERC-20,
 * as opposed to the RPC merely being unavailable.
 *
 * Only the former may be cached as `null`: `tokenCache` has no TTL, so caching a
 * transient failure blanks that token for the rest of the session — and because reads
 * now share one `aggregate3`, a single 503 would otherwise poison every token in the
 * batch at once.
 *
 * Both shapes are covered. A `success: false` entry in an `aggregate3` result throws a
 * `RawContractError`, but viem wraps it through `ExecutionRevertedError` (code 3) before
 * `getContractError` sees it, so the batched chain is
 * `ContractFunctionExecutionError -> ContractFunctionRevertedError -> ... -> RawContractError`;
 * an unbatched read of an address with no code decodes empty data into
 * `ContractFunctionZeroDataError`. Transport failures (`HttpRequestError`, `TimeoutError`)
 * match neither.
 *
 * One revert is excluded: the client refuses offchain lookups, so a token whose metadata
 * lives behind a CCIP-Read gateway reverts with `OffchainLookup` and arrives in the same
 * shape as a plain revert. That says the read was refused, not that the address has no
 * code, and caching it would blank the token for the rest of the session.
 */
function isNotAToken(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw?.startsWith(OFFCHAIN_LOOKUP_SELECTOR)) {
    return false;
  }
  return Boolean(
    err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)
  );
}

const ERC20_DECIMALS_SYMBOL = [
  parseAbiItem('function decimals() view returns (uint8)'),
  parseAbiItem('function symbol() view returns (string)'),
] as const;

/**
 * Build a `resolveToken` callback bound to a specific chain (and optional JAW API key).
 *
 * The shared client batches via Multicall3, so the `decimals` + `symbol` pair
 * below costs one request instead of two — and resolving several tokens
 * concurrently collapses into that same request.
 */
export function createTokenResolver(chainId: number, apiKey?: string) {
  const client = getJawPublicClient(chainId, apiKey);
  return async function resolveToken(address: string): Promise<TokenInfo | null> {
    const key = `${chainId}:${address.toLowerCase()}`;
    if (tokenCache.has(key)) return tokenCache.get(key) ?? null;
    try {
      const [decimals, symbol] = await Promise.all([
        client.readContract({
          address: address as `0x${string}`,
          abi: ERC20_DECIMALS_SYMBOL,
          functionName: 'decimals',
        }),
        client.readContract({
          address: address as `0x${string}`,
          abi: ERC20_DECIMALS_SYMBOL,
          functionName: 'symbol',
        }),
      ]);
      const info: TokenInfo = { address, decimals: Number(decimals), symbol: String(symbol) };
      tokenCache.set(key, info);
      return info;
    } catch (err) {
      // Negative-cache only a proven non-token; leave transient failures uncached so the
      // next render retries once the RPC recovers.
      if (isNotAToken(err)) tokenCache.set(key, null);
      return null;
    }
  };
}

/** Native-coin symbol for a chain, sourced from viem's chain config via `SUPPORTED_CHAINS`. */
export function getNativeSymbol(chainId: number): string {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId)?.nativeCurrency?.symbol ?? 'ETH';
}

/** Native-coin decimals for a chain, sourced from viem's chain config via `SUPPORTED_CHAINS`. */
export function getNativeDecimals(chainId: number): number {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId)?.nativeCurrency?.decimals ?? 18;
}

// ============================================================================
// ERC-7730 clear-signing types
// ----------------------------------------------------------------------------
// Descriptor / display / formatter type definitions shared across the
// clear-signing modules. Type-only imports from viem (erased at runtime), so
// this module carries no @jaw.id/core dependency.
// ============================================================================

import type { AbiFunction, Hex } from 'viem';
import type { DateKind } from '../displayFormat';

export type FieldFormatKind =
  | 'raw'
  | 'addressName'
  | 'tokenAmount'
  | 'amount'
  | 'date'
  | 'unit'
  | 'nftName'
  | 'duration'
  | 'enum'
  | 'calldata';

export interface FieldFormatParams {
  tokenPath?: string;
  nativeCurrencyAddress?: string | string[];
  threshold?: string;
  message?: string;
  encoding?: 'timestamp' | 'blockheight';
  decimals?: number;
  base?: string;
  prefix?: string | boolean;
  trustedSources?: string[];
  types?: string[];
  sources?: string[];
}

export interface DescriptorField {
  path: string;
  label?: string;
  format?: FieldFormatKind;
  params?: FieldFormatParams;
  $ref?: string;
  visible?: boolean | 'always' | 'never';
  fields?: DescriptorField[];
  mustMatch?: string[];
  ifNotIn?: string[];
}

export interface DescriptorFormat {
  $id?: string;
  intent?: string | Record<string, string>;
  fields?: DescriptorField[];
  required?: string[];
  excluded?: string[];
}

export interface DescriptorDefinitions {
  [name: string]: Partial<DescriptorField>;
}

export interface DescriptorMetadata {
  owner?: string;
  info?: { legalName?: string; url?: string; lastUpdate?: string };
  token?: { name?: string; ticker?: string; decimals?: number };
  enums?: Record<string, Record<string, string>>;
  contractName?: string;
}

export interface DescriptorDeployment {
  chainId: number;
  address: string;
}

export interface Descriptor {
  /**
   * ERC-7730 `includes`: a relative path to a base descriptor whose `display`/`context`
   * this file extends. The registry uses it heavily — e.g. every token's Permit binding
   * includes `ercs/eip712-erc2612-permit.json` for the shared display formats. Must be
   * resolved (merged) before reading `display.formats`, or include-based descriptors look
   * empty and silently fall back to the raw decode.
   */
  includes?: string;
  context: {
    $id?: string;
    contract?: { deployments?: DescriptorDeployment[]; abi?: unknown };
    eip712?: {
      domain?: {
        name?: string;
        chainId?: number;
        verifyingContract?: string;
        version?: string;
        salt?: string;
      };
      domainSeparator?: Hex;
      schemas?: unknown;
      deployments?: DescriptorDeployment[];
    };
  };
  metadata?: DescriptorMetadata;
  display: {
    definitions?: DescriptorDefinitions;
    formats: Record<string, DescriptorFormat>;
  };
}

// Registry index shapes.
export type CalldataIndex = Record<string, string>; // CAIP10 -> relative path

export type Eip712IndexEntry = Record<
  string, // primaryType
  Array<{ path: string; encodeTypeHashes?: string[] }>
>;
export type Eip712Index = Record<string, Eip712IndexEntry>;

// Display row produced by the formatter — what the UI actually renders.
export type DisplayRowKind = 'address' | 'tokenAmount' | 'amount' | 'date' | 'unit' | 'text' | 'raw';

export interface DisplayRow {
  label: string;
  /** Pre-formatted user-facing value. */
  value: string;
  kind: DisplayRowKind;
  /** Raw underlying value (hex address, bigint string, …) — used for copy / ENS resolution. */
  rawValue?: string;
  /** When kind === 'tokenAmount' or 'amount': the symbol shown next to the value. */
  symbol?: string;
  /** When kind === 'tokenAmount': the underlying ERC-20 address (for icon lookup). */
  tokenAddress?: string;
  /** When kind === 'date': a start (`validAfter`, …) is never flagged as past. A deadline when absent. */
  dateKind?: DateKind;
}

export interface ClearSigningDisplay {
  /** Title for the signing screen (e.g. "Swap", "Permit"). */
  intent?: string;
  /** Human-friendly contract name from descriptor metadata, e.g. "Uniswap V3 Router 2". */
  contractName?: string;
  /** Descriptor owner / issuer attribution, e.g. "Aave DAO". */
  owner?: string;
  /** URL provided by the descriptor for additional info on the issuer. */
  ownerUrl?: string;
  rows: DisplayRow[];
}

// ============================================================================
//  Path resolution context
// ----------------------------------------------------------------------------
// ERC-7730 path roots:
//   `@.X`  → transaction envelope (from, to, value, chainId, …)
//   `#.X`  → function arguments
//   `X`    → function arguments (implicit, same as `#.X`)
//   `$.X`  → descriptor-internal ($ref) — resolved upstream in mergeField, not here.
//
// Segment syntax:
//   `a.b.c`    → nested object access
//   `[n]`      → array indexing (negative from end)
//   `[]`       → iterate all elements
//   `[a:b]`    → byte slice on a `bytes`/hex value
// ============================================================================

export interface PathContext {
  args: Record<string, unknown>;
  tx: Record<string, unknown>;
}

export interface CalldataMatch {
  descriptor: Descriptor;
  formatKey: string;
  format: DescriptorFormat;
}

export interface Eip712Match {
  descriptor: Descriptor;
  formatKey: string;
  format: DescriptorFormat;
}

export type Eip712Types = Record<string, ReadonlyArray<{ name: string; type: string }>>;

export interface TokenInfo {
  address: string;
  decimals: number;
  symbol: string;
}

export interface FormatterContext extends PathContext {
  chainId: number;
  resolveToken?: (address: string) => Promise<TokenInfo | null> | TokenInfo | null;
  nativeSymbol?: string;
  nativeDecimals?: number;
}

export interface DecodedArgs {
  abiItem: AbiFunction;
  args: Record<string, unknown>;
}

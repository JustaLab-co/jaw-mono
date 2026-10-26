import { parseAbiItem } from 'viem';

import { createTokenResolver, isAnsweredReadFailure, isKnownNonToken } from './clearSigning/format';
import { caip10, getDefaultDescriptorSource } from './clearSigning/source';
import type { CalldataIndex } from './clearSigning/types';
import { getJawPublicClient } from './publicClient';
import { getChainLabel } from './resolveChainLabel';
import { identityKey, reverseResolveIdentities, type ReverseInput, type ReverseResolution } from './reverseResolve';
import { tokenIconUrl } from './tokenIcon';

// ============================================================================
//  Address identity loader
// ----------------------------------------------------------------------------
// Answers, per address and chain, the three things an address can be known by:
// its ENS name, the token it is, and its ERC-7730 clear-signing name.
//
// Every answer is published for display, and listeners hear about it. Only a
// complete answer is also kept, which spares later callers the request: a clean
// miss is kept, an outage is not, so the next caller asks again.
// ============================================================================

export type IdentitySource = 'ens' | 'token' | 'clearSigning';

/** For a screen that shows who an address is and nothing else. */
export const ENS_ONLY: readonly IdentitySource[] = ['ens'];

/** For a contract that is rarely an ENS name but may be a clear-signing one, such as a call checker. */
export const CONTRACT_NAMES: readonly IdentitySource[] = ['ens', 'clearSigning'];

export interface EnsIdentity {
  /** Primary name, suffixed `@chainlabel` off-mainnet. For showing. */
  name: string;
  /** The same name without the suffix. For anything acted on. */
  plainName: string;
  avatar: string | null;
}

export interface TokenIdentity {
  /** Null when `name()` cannot be read as a string (some tokens answer bytes32). */
  name: string | null;
  symbol: string;
  icon: string;
}

export interface ClearSigningIdentity {
  name: string;
}

export interface IdentitySources {
  ens: EnsIdentity;
  token: TokenIdentity;
  clearSigning: ClearSigningIdentity;
}

export interface IdentityContext {
  mainnetRpcUrl: string;
  apiKey?: string;
}

interface Answer<T> {
  value: T | null;
  /** Whether the answer is complete, so later callers may skip the request. */
  keep: boolean;
  /** How long a kept answer holds before the next caller asks again. Unset: the session. */
  ttlMs?: number;
}

// A name can appear mid-session: onboarding adds a subname and goes straight to Connect, before
// the reverse index has it. A miss is kept this long, so the next dialog after that asks again.
const ENS_MISS_TTL_MS = 60_000;

interface Entry {
  /** The latest answer, kept or not. What callers render. */
  value: unknown;
  /** Whether `value` holds an answer yet. */
  answered: boolean;
  /** Whether the answer is complete, so later callers may skip the request. */
  kept: boolean;
  /** When a kept answer stops counting as kept. Null: never. */
  expiresAt: number | null;
  pending: Promise<unknown> | null;
  /** Changes on every update, so a subscriber can tell whether its own keys moved. */
  revision: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let revision = 0;
// Bumped by a clear, so a request that started before it cannot write into the new store.
let generation = 0;

function update(key: string, change: Partial<Omit<Entry, 'revision'>>): void {
  const entry = entries.get(key) ?? {
    value: null,
    answered: false,
    kept: false,
    expiresAt: null,
    pending: null,
    revision: 0,
  };
  entries.set(key, { ...entry, ...change, revision: ++revision });
  listeners.forEach((listener) => listener());
}

/** Calls `listener` whenever any answer changes. Returns the unsubscribe. */
export function subscribeIdentities(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drops every answer. For tests, which would otherwise share them. */
export function clearAddressIdentityCache(): void {
  generation++;
  entries.clear();
  ensBatches.clear();
  descriptorNames.clear();
  calldataIndex = null;
}

function sourceKey(source: IdentitySource, input: ReverseInput): string {
  return `${source}:${identityKey(input.address, input.chainId)}`;
}

/** Changes whenever this source's answer for this address changes, and only then. */
export function identityRevision(source: IdentitySource, input: ReverseInput): number {
  return entries.get(sourceKey(source, input))?.revision ?? 0;
}

/**
 * The latest answer from one source for one address. `loading` holds until an answer has
 * landed, and again while a retry after an unkept one is in flight.
 */
export function peekIdentity<S extends IdentitySource>(
  source: S,
  input: ReverseInput
): { value: IdentitySources[S] | null; loading: boolean } {
  const entry = entries.get(sourceKey(source, input));
  if (!entry?.answered) return { value: null, loading: true };
  return { value: entry.value as IdentitySources[S] | null, loading: entry.pending !== null };
}

function isKept(entry: Entry | undefined): boolean {
  return !!entry?.kept && (entry.expiresAt === null || Date.now() < entry.expiresAt);
}

function remember<T>(key: string, load: () => Promise<Answer<T>>): void {
  const entry = entries.get(key);
  if (isKept(entry) || entry?.pending) return;

  const started = generation;
  const settle = (value: T | null, keep: boolean, ttlMs?: number) => {
    if (started !== generation) return;
    const expiresAt = keep && ttlMs !== undefined ? Date.now() + ttlMs : null;
    update(key, { value, answered: true, kept: keep, expiresAt, pending: null });
  };
  const request = load().then(
    ({ value, keep, ttlMs }) => settle(value, keep, ttlMs),
    // Unreachable: show nothing for now, and keep nothing so the next caller asks again.
    () => settle(null, false)
  );
  if (entry?.answered) {
    // A retry: what callers see changes from settled to loading, so they hear about it.
    update(key, { pending: request });
  } else {
    // Still loading either way; recording the request changes nothing a caller renders.
    entries.set(key, {
      value: null,
      answered: false,
      kept: false,
      expiresAt: null,
      pending: request,
      revision: entry?.revision ?? 0,
    });
  }
}

// ---- ENS -------------------------------------------------------------------
// Every address asked for before the current task ends rides one request: a screen's
// components run their effects in the same commit, so they land in the same batch.

interface EnsBatch {
  inputs: ReverseInput[];
  result: Promise<ReverseResolution>;
}

const ensBatches = new Map<string, EnsBatch>();

function joinEnsBatch(input: ReverseInput, rpcUrl: string): Promise<ReverseResolution> {
  let batch = ensBatches.get(rpcUrl);
  if (!batch) {
    const inputs: ReverseInput[] = [];
    const result = Promise.resolve().then(() => {
      if (ensBatches.get(rpcUrl) === batch) ensBatches.delete(rpcUrl);
      return reverseResolveIdentities(inputs, rpcUrl);
    });
    batch = { inputs, result };
    ensBatches.set(rpcUrl, batch);
  }
  batch.inputs.push(input);
  return batch.result;
}

async function readEns(input: ReverseInput, { mainnetRpcUrl }: IdentityContext): Promise<Answer<EnsIdentity>> {
  const { resolved, unanswered } = await joinEnsBatch(input, mainnetRpcUrl);
  const key = identityKey(input.address, input.chainId);
  if (unanswered.some((u) => identityKey(u.address, u.chainId) === key)) {
    throw new Error('Reverse resolution unanswered');
  }
  const identity = resolved[key];
  if (!identity) return { value: null, keep: true, ttlMs: ENS_MISS_TTL_MS };
  // getChainLabel remembers its own answers, a failed lookup included, so the suffix here is
  // whatever every other name on the page carries.
  const label = await getChainLabel(input.chainId, mainnetRpcUrl);
  return {
    value: {
      name: label ? `${identity.name}@${label}` : identity.name,
      plainName: identity.name,
      avatar: identity.avatar ?? null,
    },
    keep: true,
  };
}

// ---- Token -----------------------------------------------------------------
// decimals + symbol come from the resolver the signing screens use, so the two share
// its cache. name() is read beside them: the JAW client folds reads made in the same
// tick into one Multicall3 request, so it costs no extra round trip.

const NAME_ABI = [parseAbiItem('function name() view returns (string)')] as const;

async function readToken(
  { address, chainId }: ReverseInput,
  { apiKey }: IdentityContext
): Promise<Answer<TokenIdentity>> {
  const [info, name] = await Promise.all([
    createTokenResolver(chainId, apiKey)(address),
    getJawPublicClient(chainId, apiKey)
      .readContract({ address: address as `0x${string}`, abi: NAME_ABI, functionName: 'name' })
      .then(
        (value) => ({ value: String(value), keep: true }),
        (err: unknown) => ({ value: null, keep: isAnsweredReadFailure(err) })
      ),
  ]);
  if (!info) return { value: null, keep: isKnownNonToken(chainId, address) };
  return { value: { name: name.value, symbol: info.symbol, icon: tokenIconUrl(chainId, address) }, keep: name.keep };
}

// ---- Clear signing ---------------------------------------------------------
// The registry source deliberately keeps no cache, so the signing path always reads
// fresh descriptors. A display name does not need that guarantee: this keeps one index
// download per session, and one descriptor per path, for the names alone.

let calldataIndex: Promise<CalldataIndex> | null = null;

function getCalldataIndex(): Promise<CalldataIndex> {
  if (!calldataIndex) {
    const request = getDefaultDescriptorSource().getCalldataIndex();
    calldataIndex = request;
    request.catch((err: unknown) => {
      console.debug('[addressIdentity] calldata index fetch failed:', err);
      if (calldataIndex === request) calldataIndex = null;
    });
  }
  return calldataIndex;
}

const descriptorNames = new Map<string, Promise<string | null>>();

/** One descriptor per path: several deployments of a contract share one file. */
function readContractName(path: string): Promise<string | null> {
  let name = descriptorNames.get(path);
  if (!name) {
    const request = getDefaultDescriptorSource()
      .getDescriptor(path)
      .then((descriptor) => descriptor.metadata?.contractName ?? descriptor.context?.$id ?? null);
    name = request;
    descriptorNames.set(path, request);
    request.catch((err: unknown) => {
      console.debug('[addressIdentity] descriptor fetch failed:', path, err);
      if (descriptorNames.get(path) === request) descriptorNames.delete(path);
    });
  }
  return name;
}

async function readClearSigning({ address, chainId }: ReverseInput): Promise<Answer<ClearSigningIdentity>> {
  const path = (await getCalldataIndex())[caip10(chainId, address)];
  if (!path) return { value: null, keep: true };
  const name = await readContractName(path);
  return { value: name ? { name } : null, keep: true };
}

// ---- Entry point -----------------------------------------------------------

const readers: {
  [S in IdentitySource]: (input: ReverseInput, context: IdentityContext) => Promise<Answer<IdentitySources[S]>>;
} = { ens: readEns, token: readToken, clearSigning: readClearSigning };

/**
 * Asks one source about one address, unless a complete answer is already kept or the same
 * question is in flight. The answer lands through {@link peekIdentity} and the listeners.
 */
export function requestIdentity(source: IdentitySource, input: ReverseInput, context: IdentityContext): void {
  const read = readers[source] as (input: ReverseInput, context: IdentityContext) => Promise<Answer<unknown>>;
  remember(sourceKey(source, input), () => read(input, context));
}

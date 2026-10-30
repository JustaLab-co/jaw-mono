import { buildHandleJawRpcUrl, JAW_RPC_URL } from '@jaw.id/core';
import { dappOriginHeader } from '@jaw.id/core/internal';
import { overlay } from './overlay';
import { parse, tableProblem } from './parse';
import { BridgeContracts, snapshotContracts } from './table';

const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const STORAGE_KEY = 'jaw.bridgeContracts';

/** `fetchedAt` stays unset for a table read from storage, which this page has not confirmed with the proxy. */
type Held = { contracts: BridgeContracts; fetchedAt?: number };

let held: Held | undefined;
let stored = false;
let inflight: Promise<void> | undefined;

function readStored(): unknown {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(body: unknown) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(body));
  } catch {
    // Storage can be blocked or full.
  }
}

function accept(body: unknown, fetchedAt?: number): boolean {
  const result = parse(body);
  if (!result.ok) {
    console.warn(`Bridge contracts rejected: ${result.reason}`);
    return false;
  }
  const { version, chains } = result.contracts;
  const merged = overlay(snapshotContracts().chains, chains);
  const problem = tableProblem(merged);
  if (problem) {
    console.warn(`Bridge contracts rejected: ${problem}`);
    return false;
  }
  held = { contracts: new BridgeContracts({ version, chains: merged }), fetchedAt };
  return true;
}

/** Fallback order: loaded, stored, build snapshot. */
export function currentContracts(): BridgeContracts {
  if (!held && !stored) {
    stored = true;
    const body = readStored();
    if (body !== undefined) accept(body);
  }
  return held?.contracts ?? snapshotContracts();
}

async function fetchTable(apiKey: string | undefined, have: number | undefined) {
  const response = await fetch(buildHandleJawRpcUrl(JAW_RPC_URL, apiKey), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...dappOriginHeader() },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'jaw_getBridgeContracts',
      params: [have === undefined ? { schema: 1 } : { schema: 1, have }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const { result, error } = await response.json();
  if (!response.ok || error) throw new Error(error?.message ?? `HTTP ${response.status}`);
  return result;
}

async function refresh(apiKey: string | undefined) {
  const have = held?.contracts.version;
  try {
    const result = await fetchTable(apiKey, have);
    if (result?.notModified && held && held.contracts.version === result.version) {
      held = { ...held, fetchedAt: Date.now() };
    } else if (accept(result, Date.now())) {
      writeStored(result);
    }
  } catch (error) {
    console.warn('Bridge contracts could not be loaded', error);
  }
}

/** Refreshes at most once per TTL; the result is picked up through currentContracts. */
export function load(apiKey?: string): Promise<void> {
  currentContracts();
  if (held?.fetchedAt !== undefined && Date.now() - held.fetchedAt < TTL_MS) return Promise.resolve();
  return (inflight ??= refresh(apiKey).finally(() => {
    inflight = undefined;
  }));
}

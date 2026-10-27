import { buildHandleJawRpcUrl, JAW_RPC_URL } from '@jaw.id/core';
import { parse } from './parse';
import { snapshotContracts, type BridgeContracts } from './table';

const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const STORAGE_KEY = 'jaw.bridgeContracts';

type Held = { contracts: BridgeContracts; fetchedAt: number };

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

/** Takes the body only when it is no older than what is already held. */
function accept(body: unknown, fetchedAt: number): boolean {
  const result = parse(body);
  if (!result.ok) {
    console.warn(`Bridge contracts rejected: ${result.reason}`);
    return false;
  }
  const floor = held?.contracts.version ?? snapshotContracts().version;
  if (result.contracts.version < floor) return false;
  held = { contracts: result.contracts, fetchedAt };
  return true;
}

/** Fallback order: loaded, stored, build snapshot. */
export function currentContracts(): BridgeContracts {
  if (!held && !stored) {
    stored = true;
    const body = readStored();
    if (body !== undefined) accept(body, 0);
  }
  return held?.contracts ?? snapshotContracts();
}

async function fetchTable(apiKey: string | undefined, have: number | undefined) {
  const response = await fetch(buildHandleJawRpcUrl(JAW_RPC_URL, apiKey), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  if (held && held.fetchedAt > 0 && Date.now() - held.fetchedAt < TTL_MS) return Promise.resolve();
  return (inflight ??= refresh(apiKey).finally(() => {
    inflight = undefined;
  }));
}

export function resetForTests() {
  held = undefined;
  stored = false;
  inflight = undefined;
}

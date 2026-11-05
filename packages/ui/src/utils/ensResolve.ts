// ============================================================================
// ENS names to addresses, through the JustaName resolve endpoint.
//
// Moved here from the playground so the recovery start screen can find an account by its name;
// the playground imports these from `@jaw.id/ui`.
// ============================================================================

interface ResolveAddressEntry {
  id: number;
  name: string;
  value: string;
}

interface ResolveEntry {
  ens: string;
  records: {
    addresses?: ResolveAddressEntry[];
  };
}

interface ResolveResponse {
  statusCode: number;
  result: {
    data: ResolveEntry | ResolveEntry[] | null;
    error: string | null;
  };
}

const ENSIP11_OFFSET = 2147483648;
const SLIP44_ETH_COIN_TYPE = 60;

function targetCoinId(chainId: number): number {
  return chainId === 1 ? SLIP44_ETH_COIN_TYPE : ENSIP11_OFFSET + chainId;
}

function pickAddressForChain(entry: ResolveEntry, chainId: number, ensName: string): string {
  const target = targetCoinId(chainId);
  const match = entry.records.addresses?.find((a) => a.id === target);
  if (!match) {
    throw new Error(`No address found for chain ${chainId} on ENS name ${ensName}`);
  }
  return match.value;
}

async function callResolveEndpoint(query: string, ensNamesForError: string): Promise<ResolveResponse> {
  let response: Response;
  try {
    response = await fetch(`https://api.justaname.id/ens/v2/resolve?${query}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'network error';
    throw new Error(`Failed to resolve ${ensNamesForError}: ${reason}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to resolve ${ensNamesForError}: HTTP ${response.status}`);
  }

  const body = (await response.json()) as ResolveResponse;
  if (body.result?.error) {
    throw new Error(`Failed to resolve ${ensNamesForError}: ${body.result.error}`);
  }
  return body;
}

const NO_RPC_URL = 'No RPC URL is configured: cannot resolve ENS names.';

/**
 * The address an ENS name holds for `chainId` (ENSIP-11 coin type; 60 on mainnet).
 *
 * @param rpcUrl - The Ethereum mainnet RPC the endpoint resolves through
 * @throws when the name holds no address for the chain, or the lookup fails
 */
export async function resolveEnsToAddress(ensName: string, chainId: number, rpcUrl: string): Promise<string> {
  if (!rpcUrl) {
    throw new Error(NO_RPC_URL);
  }

  const query = `ens=${encodeURIComponent(ensName)}&rpcUrl=${encodeURIComponent(rpcUrl)}`;
  const body = await callResolveEndpoint(query, ensName);

  const data = body.result?.data;
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry) {
    throw new Error(`No address found for chain ${chainId} on ENS name ${ensName}`);
  }
  return pickAddressForChain(entry, chainId, ensName);
}

/** {@link resolveEnsToAddress} for several names in one request, in the order given. */
export async function resolveEnsToAddresses(ensNames: string[], chainId: number, rpcUrl: string): Promise<string[]> {
  if (ensNames.length === 0) return [];
  if (ensNames.length === 1) {
    const single = await resolveEnsToAddress(ensNames[0], chainId, rpcUrl);
    return [single];
  }

  if (!rpcUrl) {
    throw new Error(NO_RPC_URL);
  }

  const ensQuery = ensNames.map((n) => `ens=${encodeURIComponent(n)}`).join('&');
  const query = `${ensQuery}&rpcUrl=${encodeURIComponent(rpcUrl)}`;
  const body = await callResolveEndpoint(query, ensNames.join(', '));

  const data = body.result?.data;
  const entries = Array.isArray(data) ? data : data ? [data] : [];
  if (entries.length !== ensNames.length) {
    throw new Error(
      `Failed to resolve ${ensNames.join(', ')}: expected ${ensNames.length} entries, got ${entries.length}`
    );
  }

  return entries.map((entry, i) => pickAddressForChain(entry, chainId, ensNames[i]));
}

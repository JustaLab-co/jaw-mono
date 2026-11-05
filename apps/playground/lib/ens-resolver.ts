const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function isLikelyEnsName(value: string): boolean {
  if (!value) return false;
  return !HEX_ADDRESS_RE.test(value);
}

// Forward resolution (name to address) lives in `@jaw.id/ui` (`resolveEnsToAddress`,
// `resolveEnsToAddresses`); the reverse lookup below stays here.

const ENSIP11_OFFSET = 2147483648;
const SLIP44_ETH_COIN_TYPE = 60;

function targetCoinId(chainId: number): number {
  return chainId === 1 ? SLIP44_ETH_COIN_TYPE : ENSIP11_OFFSET + chainId;
}

interface ReverseResponse {
  statusCode: number;
  result: {
    data: {
      address: string;
      name: string | null;
      coinType: number;
    } | null;
    error: string | null;
  };
}

export async function reverseResolveEnsName(address: string, chainId: number, rpcUrl: string): Promise<string | null> {
  if (!rpcUrl) return null;

  const coinType = targetCoinId(chainId);
  const url = `https://api.justaname.id/ens/v2/reverse?rpcUrl=${encodeURIComponent(
    rpcUrl
  )}&address=${encodeURIComponent(address)}&coinType=${coinType}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const body = (await response.json()) as ReverseResponse;
  if (body.result?.error) return null;
  return body.result?.data?.name ?? null;
}

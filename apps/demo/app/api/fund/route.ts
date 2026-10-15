import { NextResponse } from 'next/server';
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  getAddress,
  http,
  HttpRequestError,
  isAddress,
  parseUnits,
  RpcRequestError,
  TimeoutError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { JAW_RPC_URL } from '@jaw.id/core';
import { ALREADY_FUNDED_EURE, EURE_ADDRESS, EURE_DECIMALS, FUND_AMOUNT_EURE, FUNDER_FLOOR_EURE } from '@/lib/funding';

export const runtime = 'nodejs';

const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY as `0x${string}` | undefined;

// Default RPC: the JAW proxy, authenticated with the app's API key — the same
// endpoint the SDK routes through. The ARBITRUM_SEPOLIA_RPC_URL* env vars are
// optional explicit overrides; when set they run first with the proxy as the
// failover, since providers occasionally return transient internal-error
// blips and viem's fallback transport can fail over instead of failing.
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;
const jawProxyUrl = API_KEY ? `${JAW_RPC_URL}?chainId=${arbitrumSepolia.id}&api-key=${API_KEY}` : undefined;
const rpcUrls = [
  process.env.ARBITRUM_SEPOLIA_RPC_URL,
  process.env.ARBITRUM_SEPOLIA_RPC_URL_FALLBACK,
  jawProxyUrl,
].filter((u): u is string => typeof u === 'string' && u.length > 0);

// 0 urls -> http(undefined) uses viem's default public RPC. 1 url -> that
// url. 2+ -> fail over between them.
const transport = rpcUrls.length > 1 ? fallback(rpcUrls.map((url) => http(url))) : http(rpcUrls[0]);

// Retry transient provider blips that viem's transport won't retry on its own.
// A code-19 / -32603 internal error arrives as a JSON-RPC error inside an
// otherwise-OK HTTP response, so viem's default shouldRetry treats it as
// terminal — but the provider explicitly asks us to retry. We do NOT retry
// deterministic errors (reverts, bad params), only server-side blips.
const RETRY_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientRpcError = (err: unknown): boolean => {
  if (!(err instanceof BaseError)) return false;
  return Boolean(
    err.walk((e) => {
      if (e instanceof HttpRequestError || e instanceof TimeoutError) return true;
      if (e instanceof RpcRequestError)
        // 19: dRPC "Temporary internal error". -32603: JSON-RPC internal error.
        return e.code === 19 || e.code === -32603;
      return false;
    })
  );
};

const withRpcRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === RETRY_ATTEMPTS || !isTransientRpcError(err)) throw err;
      // Exponential backoff: 150ms, 300ms, 600ms.
      await sleep(150 * 2 ** attempt);
    }
  }
  throw lastErr;
};

export async function POST(request: Request) {
  if (!TREASURY_PRIVATE_KEY) {
    return NextResponse.json({ error: 'Funder not configured' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const address = (body as { address?: unknown })?.address;
  if (typeof address !== 'string' || !isAddress(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 });
  }

  const account = privateKeyToAccount(TREASURY_PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport });

  try {
    // Skip funding if the account already holds enough to run the demo.
    const recipientBalance = await withRpcRetry(() =>
      publicClient.readContract({
        address: EURE_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [getAddress(address)],
      })
    );
    if (recipientBalance >= parseUnits(ALREADY_FUNDED_EURE, EURE_DECIMALS)) {
      return NextResponse.json({ skipped: true });
    }

    // Guardrail: refuse below a floor so the demo never half-funds an account.
    const funderBalance = await withRpcRetry(() =>
      publicClient.readContract({
        address: EURE_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      })
    );
    if (funderBalance < parseUnits(FUNDER_FLOOR_EURE, EURE_DECIMALS)) {
      return NextResponse.json({ error: 'Demo is out of testnet funds' }, { status: 503 });
    }

    const walletClient = createWalletClient({
      account,
      chain: arbitrumSepolia,
      transport,
    });
    const txHash = await withRpcRetry(() =>
      walletClient.writeContract({
        address: EURE_ADDRESS,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [getAddress(address), parseUnits(FUND_AMOUNT_EURE, EURE_DECIMALS)],
      })
    );
    return NextResponse.json({ txHash });
  } catch (err) {
    console.error('[/api/fund] transfer failed:', err);
    const message =
      (err as { shortMessage?: string })?.shortMessage ?? (err instanceof Error ? err.message : 'Funding failed');
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

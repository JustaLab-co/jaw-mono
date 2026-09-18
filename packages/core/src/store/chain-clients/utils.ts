import { createPublicClient, defineChain, http, PublicClient } from 'viem';
import { BundlerClient, createBundlerClient, createPaymasterClient } from 'viem/account-abstraction';

import { ChainClients } from './store.js';
import { RPCResponseNativeCurrency } from '../../messages/rpcMessage.js';
import { JAW_PROXY_URL, JAW_RPC_URL } from '../../constants.js';
import { getSupportedChains, SUPPORTED_CHAINS } from '../../account/smartAccount.js';
import { createPaymasterFunctions } from '../../account/paymaster.js';
import { store } from '../store.js';
import { jawHttp } from '../../utils/jawHttp.js';

/**
 * Paymaster configuration for a chain
 */
import type { PaymasterConfig } from '../../provider/interface.js';
export type { PaymasterConfig };

export type SDKChain = {
    id: number;
    rpcUrl?: string;
    nativeCurrency?: RPCResponseNativeCurrency;
    /** Optional paymaster configuration for sponsored transactions */
    paymaster?: PaymasterConfig;
};

/**
 * Creates clients (PublicClient and BundlerClient) for a single chain.
 * This is used for lazy loading - clients are only created when first accessed.
 * If the chain has a paymasterUrl configured, the BundlerClient will include paymaster support.
 *
 * @param chain - The chain configuration to create clients for
 * @returns Object containing the PublicClient and BundlerClient, or undefined if no rpcUrl
 */
function createClientForChain(chain: SDKChain): { client: PublicClient; bundlerClient: BundlerClient } | undefined {
    if (!chain.rpcUrl) {
        return undefined;
    }

    // viem derives every client's pollingInterval from chain.blockTime, falling
    // back to a 12s L1 assumption — which clamps to 4s of polling. This chain is
    // synthesized from SDK config, so without blockTime the receipt wait in
    // waitForReceiptInBackground polls every 4s even on chains with sub-second
    // blocks, adding up to 4s of dead time after the userOp is already included.
    // Carry over the real blockTime when viem knows the chain; unknown chains
    // keep viem's default. blockTime has no other effect on these clients.
    //
    // `contracts` is carried over for the same reason: it holds the Multicall3
    // address that the client's `batch.multicall` needs to fold concurrent
    // eth_calls into one request. Without it viem silently falls back to one
    // request per call (see the batch option below).
    const known = SUPPORTED_CHAINS.find((c) => c.id === chain.id);
    const blockTime = known?.blockTime;

    const viemchain = defineChain({
        id: chain.id,
        ...(blockTime !== undefined && { blockTime }),
        ...(known?.contracts !== undefined && { contracts: known.contracts }),
        rpcUrls: {
            default: {
                http: [chain.rpcUrl],
            },
        },
        name: chain.nativeCurrency?.name ?? '',
        nativeCurrency: {
            name: chain.nativeCurrency?.name ?? '',
            symbol: chain.nativeCurrency?.symbol ?? '',
            decimals: chain.nativeCurrency?.decimal ?? 18,
        },
    });

    const client = createPublicClient({
        chain: viemchain,
        transport: jawHttp(chain.rpcUrl),
        // Fold eth_calls issued in the same tick into a single Multicall3
        // aggregate3 — callers that fan out over N tokens (balances, decimals,
        // symbols) pay one round-trip instead of N. aggregate3 sets
        // allowFailure, so a reverting call still rejects only its own caller,
        // and every call in the group reads the same block.
        //
        // Deliberately NOT `http(url, { batch: true })`: viem's HTTP batch
        // scheduler is a module-global map keyed by URL, so it would merge
        // requests across unrelated clients sharing this rpcUrl and run the
        // whole batch under whichever client opened the window — silently
        // overriding the tuned timeout/retry budget in erc20Paymaster's
        // eth_simulateV1 client. The multicall scheduler is keyed by client.uid.
        //
        // Chains whose viem definition carries no Multicall3 address fall back
        // to one request per call; viem swallows the lookup error internally.
        batch: { multicall: true },
    });

    // If no paymaster URL, return bundler client without paymaster
    if (!chain.paymaster?.url) {
        const bundlerClient = createBundlerClient({
            chain: viemchain,
            client,
            transport: jawHttp(chain.rpcUrl),
        });
        return { client, bundlerClient };
    }

    // Create paymaster client and wrap with custom functions that handle gas price fetching and v0.8 gas limits
    const paymasterClient = createPaymasterClient({
        // A paymaster can be another company's server, and which dApp the user is
        // on is not theirs to learn. Ours is the only one told.
        transport: chain.paymaster.url.startsWith(JAW_PROXY_URL)
            ? jawHttp(chain.paymaster.url)
            : http(chain.paymaster.url),
    });

    const bundlerClient = createBundlerClient({
        chain: viemchain,
        client,
        paymaster: createPaymasterFunctions(client, paymasterClient, chain.id, chain.paymaster.context),
        transport: jawHttp(chain.rpcUrl),
    });

    return { client, bundlerClient };
}

/**
 * Creates clients for multiple chains.
 *
 * @param chains - Array of chains to create clients for
 */
export function createClients(chains: SDKChain[]) {
    chains.forEach((chain) => {
        const clients = createClientForChain(chain);
        if (clients) {
            ChainClients.setState({
                ...ChainClients.getState(),
                [chain.id]: clients,
            });
        }
    });
}

/**
 * Gets or creates a PublicClient for a chain.
 * If the client doesn't exist, it will be created lazily from the chain config in the store.
 *
 * @param chainId - The chain ID to get the client for
 * @returns The PublicClient, or undefined if the chain is not configured
 */
export function getClient(chainId: number): PublicClient | undefined {
    // Check if client already exists
    const existingClient = ChainClients.getState()[chainId]?.client;
    if (existingClient) {
        return existingClient;
    }

    // Lazy create: find chain in store and create client
    const chains = store.getState().chains ?? [];
    const chain = chains.find((c) => c.id === chainId);
    if (!chain) {
        return undefined;
    }

    const clients = createClientForChain(chain);
    if (clients) {
        ChainClients.setState({
            ...ChainClients.getState(),
            [chainId]: clients,
        });
        return clients.client;
    }

    return undefined;
}

/**
 * Gets or creates a BundlerClient for a chain.
 * If the client doesn't exist, it will be created lazily from the chain config in the store.
 *
 * @param chainId - The chain ID to get the bundler client for
 * @returns The BundlerClient, or undefined if the chain is not configured
 */
export function getBundlerClient(chainId: number): BundlerClient | undefined {
    // Check if client already exists
    const existingClient = ChainClients.getState()?.[chainId]?.bundlerClient;
    if (existingClient) {
        return existingClient;
    }

    // Lazy create: find chain in store and create client
    const chains = store.getState().chains ?? [];
    const chain = chains.find((c) => c.id === chainId);
    if (!chain) {
        return undefined;
    }

    const clients = createClientForChain(chain);
    if (clients) {
        ChainClients.setState({
            ...ChainClients.getState(),
            [chainId]: clients,
        });
        return clients.bundlerClient;
    }

    return undefined;
}

/**
 * Creates initial chains with RPC URLs for all supported chains.
 * RPC URLs are constructed as: {JAW_RPC_URL}?chainId={chainId}&api-key={apiKey},
 * dropping the parameter when there is no key rather than sending it empty.
 *
 * @param apiKey - API key for authentication, if the caller has one
 * @param paymasters - Optional mapping of chain IDs to paymaster configuration
 * @param showTestnets - Whether to include testnet chains (default: false)
 * @returns Array of SDKChain objects with constructed RPC URLs for supported chains
 *
 * @example
 * ```typescript
 * const chains = createInitialChains(
 *   'api-key',
 *   {
 *     84532: {
 *       url: 'https://api.pimlico.io/v2/84532/rpc?apikey=...',
 *       context: { sponsorshipPolicyId: 'sp_my_policy' }
 *     }
 *   },
 *   true
 * );
 * ```
 */
export function createInitialChains(
    apiKey?: string,
    paymasters?: Record<number, PaymasterConfig>,
    showTestnets = false
): SDKChain[] {
    const chains = getSupportedChains(showTestnets);
    return chains.map((chain) => ({
        id: chain.id,
        rpcUrl: apiKey ? `${JAW_RPC_URL}?chainId=${chain.id}&api-key=${apiKey}` : `${JAW_RPC_URL}?chainId=${chain.id}`,
        ...(paymasters?.[chain.id] ? { paymaster: paymasters[chain.id] } : {}),
    }));
}

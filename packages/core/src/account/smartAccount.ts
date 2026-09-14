import {
    Address,
    Client,
    getAddress,
    Hash,
    Hex,
    isAddress,
    pad,
    Transport,
    Chain as ViemChain,
    formatUnits,
    http,
    createPublicClient,
    LocalAccount,
    encodeFunctionData,
    decodeFunctionResult,
    defineChain,
} from 'viem';
import { call, getCode, getGasPrice, multicall, readContract } from 'viem/actions';
import {
    abi,
    factoryAbi,
    JustanAccountImplementation,
    toJustanAccount,
    type ToJustanAccountReturnType,
} from './toJustanAccount.js';
import { isDelegatedToImplementation } from './delegation.js';
import { createPaymasterFunctions } from './paymaster.js';
import {
    BundlerClient,
    SmartAccount,
    createBundlerClient,
    createPaymasterClient,
    WebAuthnAccount,
} from 'viem/account-abstraction';
import { Chain } from '../store/index.js';
import {
    arbitrum,
    arbitrumSepolia,
    avalancheFuji,
    base,
    baseSepolia,
    celo,
    celoSepolia,
    linea,
    mainnet,
    optimism,
    flare,
    polygon,
    optimismSepolia,
    sepolia,
    avalanche,
    bsc,
    ink,
    gnosis,
    arcTestnet,
    robinhood,
    soneium,
    unichain,
    monad,
} from 'viem/chains';
import { PERMISSIONS_MANAGER_ADDRESS, FACTORY_ADDRESS } from '../constants.js';
import { standardErrors } from '../errors/errors.js';
import {
    getPermissionFromRelay,
    relayPermissionToPermission,
    encodeExecuteBatchWithPermission,
    type Permission,
} from '../rpc/permissions.js';
import { notifyReceiptReceived } from '../analytics/index.js';

export type FindOwnerIndexParams = {
    /**
     * The address of the account to get the owner index for
     */
    address: `0x${string}`;
    /**
     * The client to use to get the code and read the contract
     */
    client: Client;
    /**
     * The public key of the owner
     */
    publicKey: Hex;
};

export type BundledTransactionResult = {
    /**
     * The user operation hash
     */
    id: Hash;
    /**
     * The chain id
     */
    chainId: number;
};

/**
 * HyveChain (7847). Defined here rather than imported because viem has no
 * definition for it (checked against 2.55.16); wevm/viem#5063 adds one but is
 * still open. Everything this list is read for is deployed at its canonical
 * address: the factory, the permissions manager, EntryPoint v0.8, and
 * Multicall3. The ERC-20 paymaster is not, so ERC-20 gas is simply absent on
 * this chain rather than broken — that path is driven by per-chain config.
 *
 * Every field below is kept byte-identical to #5063 so that adopting viem's
 * definition later is a pure import swap, with one deliberate exception:
 * blockTime, which that PR omits. It is measured, not assumed — blocks
 * alternate 3s/4s, so 3500ms keeps the receipt poll in step instead of
 * dropping to viem's 12s L1 default (which clamps to a 4s poll and adds dead
 * time after inclusion). Whoever swaps in viem's export must re-add blockTime
 * on top of it, or fast receipts silently regress.
 *
 * Multicall3's blockCreated is verified against the chain, not copied: 4090845
 * holds no code at that address and 4090846 holds the deployment. It matters
 * more here than
 * on most chains because createClientForChain only carries `contracts` over for
 * chains this list knows, and `batch.multicall` degrades silently to one
 * request per eth_call without it (see store/chain-clients/utils.ts).
 *
 * Note for anyone extending this: the public RPC is a Cosmos-SDK EVM node and
 * does not implement eth_simulateV1, so simulation-backed paths fall back.
 */
const hyveChain = /*#__PURE__*/ defineChain({
    id: 7847,
    name: 'HyveChain',
    nativeCurrency: { name: 'HYVE', symbol: 'HYVE', decimals: 18 },
    blockTime: 3500,
    rpcUrls: {
        default: {
            http: ['https://rpc.hyvechain.com'],
            webSocket: ['wss://ws.hyvechain.com'],
        },
    },
    blockExplorers: {
        default: { name: 'HyveChain Explorer', url: 'https://explorer.hyvechain.com' },
    },
    contracts: {
        multicall3: {
            address: '0xcA11bde05977b3631167028862bE2a173976CA11',
            blockCreated: 4090846,
        },
    },
    testnet: false,
});

/**
 * The chain lists are annotated rather than inferred on purpose. Without the
 * annotation TypeScript keeps the full literal type of every viem chain, down
 * to each explorer URL, which is not a contract we want to publish: it made the
 * api-extractor report 14988 lines, of which these four exports were 90%, and
 * any viem minor that edits chain metadata rewrote thousands of report lines on
 * a PR that changed nothing here.
 *
 * `readonly` because these are module-level constants shared by every consumer.
 * Mutating one in place would corrupt chain resolution process-wide.
 */
export const MAINNET_CHAINS: readonly ViemChain[] = [
    mainnet,
    base,
    optimism,
    arbitrum,
    linea,
    avalanche,
    bsc,
    celo,
    flare,
    polygon,
    ink,
    gnosis,
    robinhood,
    soneium,
    hyveChain,
    unichain,
    monad,
];

export const TESTNET_CHAINS: readonly ViemChain[] = [
    sepolia,
    baseSepolia,
    optimismSepolia,
    arbitrumSepolia,
    celoSepolia,
    avalancheFuji,
    arcTestnet,
];

export const SUPPORTED_CHAINS: readonly ViemChain[] = [...MAINNET_CHAINS, ...TESTNET_CHAINS];

/**
 * Get supported chains based on testnet preference.
 *
 * @param showTestnets - Whether to include testnet chains (default: false)
 * @returns Array of supported chains
 */
export function getSupportedChains(showTestnets = false): readonly ViemChain[] {
    return showTestnets ? SUPPORTED_CHAINS : MAINNET_CHAINS;
}

/**
 * Gets or creates a bundler client for a chain using lazy loading.
 * Clients are cached in the store and created only when first accessed.
 *
 * @param chain - The chain to get the bundler client for
 * @param paymasterUrlOverride - Optional paymaster URL that takes priority over chain.paymasterUrl.
 *                               Used when wallet_sendCalls includes a paymasterService capability.
 * @param paymasterContextOverride - Optional paymaster context that takes priority over chain.paymasterContext.
 *                                   Used when wallet_sendCalls includes paymaster context in capabilities.
 * @returns The bundler client for the specified chain
 * @throws Error if the chain is not supported or client creation fails
 */
export const getBundlerClient = (
    chain: Chain,
    paymasterUrlOverride?: string,
    paymasterContextOverride?: Record<string, unknown>
): BundlerClient<Transport, ViemChain> => {
    const viemChain = SUPPORTED_CHAINS.find((c) => c.id === chain.id);

    // Deliberately no `batch: { multicall: true }` here, unlike the store's client in
    // store/chain-clients/utils.ts. That option folds eth_calls that happen to be issued
    // in the same tick, and nothing on this path fans out that way: the account
    // implementation and scanOwnerIndex read through the bundler client below, and this
    // one is asked for estimateFeesPerGas/getGasPrice. scanOwnerIndex does aggregate its
    // owner reads, but it calls the multicall action outright rather than relying on the
    // scheduler, so the option would buy nothing and would add a Multicall3 hop and a
    // setTimeout(0) defer to the userOp path.
    //
    // It does still matter that `viemChain` carries the Multicall3 address, which is why
    // scanOwnerIndex reads it off the chain and falls back when it is missing: an
    // unlisted chain resolves to `undefined` here.
    const publicClient = createPublicClient({
        chain: viemChain,
        transport: http(chain.rpcUrl),
    });

    // Priority: overrides (from capabilities) > chain config (from SDK config).
    // The url decides for the pair. Resolving the two independently lets them
    // come from different sources: a caller passing only a url override, on an
    // account configured with `paymasterContext`, would send that context to the
    // other paymaster. A context belongs to the paymaster it was written for.
    const fromOverride = paymasterUrlOverride !== undefined;
    const effectivePaymasterUrl = fromOverride ? paymasterUrlOverride : chain.paymaster?.url;
    const effectivePaymasterContext = fromOverride ? paymasterContextOverride : chain.paymaster?.context;

    // If no paymaster URL, return bundler client without paymaster
    if (!effectivePaymasterUrl) {
        return createBundlerClient({
            client: publicClient,
            transport: http(chain.rpcUrl),
        });
    }

    const paymasterClient = createPaymasterClient({
        transport: http(effectivePaymasterUrl),
    });

    // Use shared paymaster functions that handle gas price fetching and v0.8 gas limits
    return createBundlerClient({
        client: publicClient,
        paymaster: createPaymasterFunctions(publicClient, paymasterClient, chain.id, effectivePaymasterContext),
        transport: http(chain.rpcUrl),
    });
};

type PreparedCalls = {
    calls: Array<{ to: Address; value: bigint; data: Hex }>;
    authorization?: Awaited<ReturnType<ToJustanAccountReturnType['signAuthorization']>>;
};

/**
 * Prepares calls for EIP-7702 execution by checking delegation status
 * and prepending owner setup if needed.
 */
async function prepareEip7702Calls(
    smartAccount: SmartAccount,
    localAccount: LocalAccount,
    calls: Array<{ to: Address; value: bigint; data: Hex }>,
    chain: Chain
): Promise<PreparedCalls> {
    // No multicall batching: the three reads below are strictly sequential (each one
    // gates the next), so there is never more than one eth_call in flight to fold.
    const publicClient = createPublicClient({
        chain: SUPPORTED_CHAINS.find((c) => c.id === chain.id),
        transport: http(chain.rpcUrl),
    });

    const implementationAddress = await readContract(publicClient, {
        address: FACTORY_ADDRESS as Address,
        abi: factoryAbi,
        functionName: 'getImplementation',
    });

    const delegated = await isDelegatedToImplementation(publicClient, localAccount.address, implementationAddress);

    // Sign authorization if not yet delegated to our implementation
    const authorization = !delegated
        ? await (smartAccount as ToJustanAccountReturnType).signAuthorization()
        : undefined;

    let finalCalls = [...calls];

    // Check if permissions manager is already an owner.
    // When not delegated, use stateOverride to simulate the delegation code
    // so we can read storage even if the EOA has no code yet (handles re-delegation
    // where storage persists after clearing delegation).
    let isPmOwner = false;
    try {
        const callData = encodeFunctionData({
            abi,
            functionName: 'isOwnerAddress',
            args: [PERMISSIONS_MANAGER_ADDRESS],
        });
        const { data: resultData } = await call(publicClient, {
            to: localAccount.address,
            data: callData,
            ...(!delegated
                ? {
                      stateOverride: [
                          {
                              address: localAccount.address,
                              code: `0xef0100${implementationAddress.slice(2)}` as Hex,
                          },
                      ],
                  }
                : {}),
        });
        if (resultData) {
            isPmOwner = decodeFunctionResult({
                abi,
                functionName: 'isOwnerAddress',
                data: resultData,
            });
        }
    } catch {
        isPmOwner = false;
    }

    if (!isPmOwner) {
        finalCalls = [
            {
                to: getAddress(localAccount.address),
                value: 0n,
                data: encodeFunctionData({
                    abi,
                    functionName: 'addOwnerAddress',
                    args: [PERMISSIONS_MANAGER_ADDRESS],
                }),
            },
            ...finalCalls,
        ];
    }

    return { calls: finalCalls, authorization };
}

/**
 * Formats raw calls and applies EIP-7702 preparation when a localAccount is present.
 * For non-7702 accounts (no localAccount), just formats the calls.
 */
export async function prepareCallsForExecution(
    smartAccount: SmartAccount,
    calls: Array<{ to: Address; value?: bigint; data?: Hex }>,
    chain: Chain,
    localAccount?: LocalAccount
): Promise<PreparedCalls> {
    const formatted = calls.map((call) => ({
        to: getAddress(call.to),
        value: call.value ?? 0n,
        data: (call.data ?? '0x') as Hex,
    }));

    if (!localAccount) {
        return { calls: formatted };
    }

    return prepareEip7702Calls(smartAccount, localAccount, formatted, chain);
}

export async function sendTransaction(
    smartAccount: SmartAccount,
    calls: Array<{
        to: Address;
        value?: bigint;
        data?: Hex;
    }>,
    chain: Chain,
    paymasterUrlOverride?: string,
    paymasterContextOverride?: Record<string, unknown>,
    apiKey?: string,
    localAccount?: LocalAccount
): Promise<Hash> {
    const bundlerClient = getBundlerClient(chain, paymasterUrlOverride, paymasterContextOverride);

    const { calls: finalCalls, authorization } = await prepareCallsForExecution(
        smartAccount,
        calls,
        chain,
        localAccount
    );

    const userOpHash = await bundlerClient.sendUserOperation({
        account: smartAccount,
        calls: finalCalls,
        ...(authorization ? { authorization } : {}),
    });

    // Wait for the transaction receipt and get the actual transaction hash
    const receipt = await bundlerClient.waitForUserOperationReceipt({
        hash: userOpHash,
    });

    // Fire-and-forget notification to proxy
    if (apiKey) {
        // Extract the actual receipt - same logic as wallet_sendCalls.ts
        const actualReceipt = (receipt as any).receipt || receipt;
        const receiptStatus = actualReceipt.status;

        // Determine if transaction succeeded:
        // - status === '0x1' or 1 means success
        // - If status is undefined but transactionHash exists, assume success (included on-chain)
        const isSuccess =
            receiptStatus === '0x1' ||
            receiptStatus === 1 ||
            (receiptStatus === undefined && actualReceipt.transactionHash !== undefined);

        notifyReceiptReceived({
            userOpHash,
            transactionHash: actualReceipt.transactionHash,
            success: isSuccess,
            apiKey,
        });
    }

    return receipt.receipt.transactionHash;
}

export async function sendCalls(
    smartAccount: SmartAccount,
    calls: Array<{
        to: Address;
        value?: bigint;
        data?: Hex;
    }>,
    chain: Chain,
    paymasterUrlOverride?: string,
    paymasterContextOverride?: Record<string, unknown>,
    localAccount?: LocalAccount
): Promise<BundledTransactionResult> {
    const bundlerClient = getBundlerClient(chain, paymasterUrlOverride, paymasterContextOverride);

    const { calls: finalCalls, authorization } = await prepareCallsForExecution(
        smartAccount,
        calls,
        chain,
        localAccount
    );

    const userOpHash = await bundlerClient.sendUserOperation({
        account: smartAccount,
        calls: finalCalls,
        ...(authorization ? { authorization } : {}),
    });

    return {
        id: userOpHash,
        chainId: chain.id,
    };
}

/**
 * Wrap calls into the single permission-manager call a permission send executes:
 * `PERMISSIONS_MANAGER.executeBatchWithPermission(permission, calls)`.
 *
 * Exported because the ERC-20 paymaster approval has to be sized over the userOp
 * that actually goes out. The wrapper's signature verification and spend
 * accounting cost gas the raw calls do not, so sizing over the raw calls puts the
 * ceiling being approved under what the paymaster then charges. Callers build the
 * wrapper with this, size the approval over it, and hand it back to
 * `sendCallsWithPermission` as `permissionCall`, so the shape cannot drift and
 * the permission is still fetched only once.
 *
 * @param permission - The permission to execute under
 * @param calls - Array of calls to execute
 * @returns The spender-level call to the permission manager
 */
export function buildPermissionManagerCall(
    permission: Permission,
    calls: Array<{
        to: Address;
        value?: bigint;
        data?: Hex;
    }>
): { to: Address; value: bigint; data: Hex } {
    const formattedCalls = calls.map((call) => ({
        target: getAddress(call.to),
        value: call.value ?? 0n,
        data: call.data ?? ('0x' as Hex),
    }));

    return {
        to: getAddress(PERMISSIONS_MANAGER_ADDRESS),
        value: 0n,
        data: encodeExecuteBatchWithPermission(permission, formattedCalls),
    };
}

/**
 * Send multiple calls using a permission.
 * This encodes the calls and sends them through the JustaPermissionManager contract's executeBatch function.
 *
 * @param smartAccount - The smart account to send from
 * @param calls - Array of calls to execute
 * @param chain - The chain to send on
 * @param permissionId - The ID (hash) of the permission to use
 * @param apiKey - API key for fetching permission from relay
 * @param permissionCall - The already-encoded permission-manager call, when the
 *        caller built one to size the paymaster approval. Skips a second relay
 *        fetch, and guarantees the userOp that was sized is the one sent.
 * @returns The bundled transaction result with userOpHash and chainId
 */
export async function sendCallsWithPermission(
    smartAccount: SmartAccount,
    calls: Array<{
        to: Address;
        value?: bigint;
        data?: Hex;
    }>,
    chain: Chain,
    permissionId: Hex,
    apiKey: string,
    paymasterUrlOverride?: string,
    paymasterContextOverride?: Record<string, unknown>,
    localAccount?: LocalAccount,
    approvalCall?: { to: Address; value?: bigint; data: Hex },
    permissionCall?: { to: Address; value: bigint; data: Hex }
): Promise<BundledTransactionResult> {
    // A caller that sized an ERC-20 paymaster approval already built this call to
    // size it over; reuse it rather than fetching the permission a second time and
    // re-encoding, which is also what keeps the sized userOp and the sent one identical.
    const managerCall =
        permissionCall ??
        buildPermissionManagerCall(
            relayPermissionToPermission(await getPermissionFromRelay(permissionId, apiKey)),
            calls
        );

    // Build the spender-level calls: optional paymaster approval + permission manager call.
    // The approval must be at this level (not inside the permission batch) because the
    // permission manager validates each call's selector against the permission.
    const spenderCalls: Array<{ to: Address; value: bigint; data: Hex }> = [];

    if (approvalCall) {
        spenderCalls.push({
            to: approvalCall.to,
            value: approvalCall.value ?? 0n,
            data: approvalCall.data,
        });
    }

    spenderCalls.push(managerCall);

    // EIP-7702: prepend delegation authorization + owner setup if needed
    const { calls: finalCalls, authorization } = localAccount
        ? await prepareEip7702Calls(smartAccount, localAccount, spenderCalls, chain)
        : { calls: spenderCalls, authorization: undefined };

    const bundlerClient = getBundlerClient(chain, paymasterUrlOverride, paymasterContextOverride);

    const userOpHash = await bundlerClient.sendUserOperation({
        account: smartAccount,
        calls: finalCalls,
        ...(authorization ? { authorization } : {}),
    });

    return {
        id: userOpHash,
        chainId: chain.id,
    };
}

export async function estimateUserOpGas(
    smartAccount: SmartAccount,
    calls: Array<{
        to: Address;
        value?: bigint;
        data?: Hex;
    }>,
    chain: Chain,
    paymasterUrlOverride?: string
): Promise<bigint> {
    const bundlerClient = getBundlerClient(chain, paymasterUrlOverride);

    const gasEstimate = await bundlerClient.estimateUserOperationGas({
        account: smartAccount,
        calls: calls.map((call) => ({
            to: call.to,
            value: call.value ?? 0n,
            data: call.data ?? '0x',
        })),
    });

    return gasEstimate.callGasLimit + gasEstimate.preVerificationGas + gasEstimate.verificationGasLimit;
}

/**
 * Estimate gas for a user operation using a permission.
 * This estimates gas for calls routed through the JustaPermissionManager contract's executeBatch function.
 *
 * @param smartAccount - The smart account to estimate for
 * @param calls - Array of calls to execute
 * @param chain - The chain to estimate on
 * @param permissionId - The ID (hash) of the permission to use
 * @param apiKey - API key for fetching permission from relay
 * @returns The estimated gas amount
 */
export async function estimateUserOpGasWithPermission(
    smartAccount: SmartAccount,
    calls: Array<{
        to: Address;
        value?: bigint;
        data?: Hex;
    }>,
    chain: Chain,
    permissionId: Hex,
    apiKey: string
): Promise<bigint> {
    // Built the same way the send builds it, so what is estimated stays the shape
    // that goes out.
    const permissionCall = buildPermissionManagerCall(
        relayPermissionToPermission(await getPermissionFromRelay(permissionId, apiKey)),
        calls
    );

    const bundlerClient = getBundlerClient(chain);

    const gasEstimate = await bundlerClient.estimateUserOperationGas({
        account: smartAccount,
        calls: [permissionCall],
    });

    return gasEstimate.callGasLimit + gasEstimate.preVerificationGas + gasEstimate.verificationGasLimit;
}

export async function createSmartAccount(
    account: WebAuthnAccount | LocalAccount,
    bundlerClient: JustanAccountImplementation['client']
): Promise<SmartAccount> {
    // First create a temporary smart account to get the predicted address
    const tempSmartAccount = await toJustanAccount({
        client: bundlerClient,
        owners: [account, PERMISSIONS_MANAGER_ADDRESS],
    });

    // Get the predicted smart account address
    const smartAccountAddress = await tempSmartAccount.getAddress();

    // Determine the owner bytes to search for based on account type
    // WebAuthn accounts use publicKey, LocalAccounts use padded address
    const ownerBytes: Hex = account.type === 'webAuthn' ? account.publicKey : pad(account.address);

    // Find the actual owner index for this account
    const ownerIndex = await findOwnerIndex({
        address: smartAccountAddress,
        client: bundlerClient,
        publicKey: ownerBytes,
    });

    // Create the smart account with the correct owner index
    return await toJustanAccount({
        client: bundlerClient,
        owners: [account, PERMISSIONS_MANAGER_ADDRESS],
        ownerIndex,
    });
}

/**
 * Owner slots read per aggregate.
 *
 * The scan is bounded by `nextOwnerIndex`, which is a value an account we were
 * handed reports about itself: `resolveSmartAccount` takes the address straight
 * off `from`/`options.address`, so a dapp picks it. Building the whole scan up
 * front would let that number decide how much we allocate, and a window keeps
 * both the allocation and the request body bounded no matter what comes back.
 *
 * 256 is sized off the request rather than picked round: one window encodes to
 * roughly 112 KB of JSON-RPC body, and it covers any account anyone has in one
 * request.
 */
const OWNER_SCAN_WINDOW = 256;

/**
 * Scan the owner slots of an account for `publicKey`, lowest index first.
 *
 * Bounded by `nextOwnerIndex`, not by `ownerCount`. `MultiOwnable` derives the
 * count as `nextOwnerIndex - removedOwnersCount` and never reuses or compacts a
 * removed slot, so after any removal the highest owners sit past the count.
 * Removed slots read back empty and simply do not match, which is a `delete` on
 * the `s_ownerAtIndex` mapping (MultiOwnable.sol:304) rather than a revert, so
 * the aggregate below can run with `allowFailure: false`.
 *
 * Reads a window at a time, aggregated where the chain has Multicall3. An
 * account that has rotated owners often has far more slots than live owners, and
 * this runs on every signing path, so the sequential read it replaces cost one
 * round-trip per slot.
 *
 * @returns the index of the owner, or undefined if it holds none.
 */
async function scanOwnerIndex({ address, client, publicKey }: FindOwnerIndexParams): Promise<number | undefined> {
    const nextOwnerIndex = await readContract(client, {
        address,
        abi,
        functionName: 'nextOwnerIndex',
    });

    const slots = Number(nextOwnerIndex);
    const formatted = formatPublicKey(publicKey).toLowerCase();

    // Multicall3 is not deployed everywhere, and getBundlerClient builds its
    // public client from `SUPPORTED_CHAINS.find(...)`, which is undefined for a
    // chain the SDK does not know. Rather than turn an unknown chain into a
    // failure, fall back to the sequential read below.
    const multicallAddress = client.chain?.contracts?.multicall3?.address;

    for (let start = 0; start < slots; start += OWNER_SCAN_WINDOW) {
        const length = Math.min(OWNER_SCAN_WINDOW, slots - start);
        const contracts = Array.from(
            { length },
            (_, i) =>
                ({
                    address,
                    abi,
                    functionName: 'ownerAtIndex',
                    args: [BigInt(start + i)],
                }) as const
        );

        if (multicallAddress) {
            const owners = await multicall(client, {
                contracts,
                allowFailure: false,
                multicallAddress,
                // viem chunks by calldata size, 1024 bytes by default, and one
                // `ownerAtIndex` call is 36 of them, so left alone it would send
                // a full window as ten requests. The window is already the
                // bound, so send it as one.
                batchSize: 0,
            });

            const hit = owners.findIndex((owner) => owner.toLowerCase() === formatted);
            if (hit !== -1) {
                return start + hit;
            }
            continue;
        }

        for (const [i, contract] of contracts.entries()) {
            const owner = await readContract(client, contract);

            if (owner.toLowerCase() === formatted) {
                return start + i;
            }
        }
    }

    return undefined;
}

export async function findOwnerIndex({ address, client, publicKey }: FindOwnerIndexParams): Promise<number> {
    const code = await getCode(client, {
        address,
    });

    // If no code deployed, return 0
    if (!code) {
        return 0;
    }

    // Deliberately not wrapped in a try/catch. The `!code` guard above is what
    // the old catch was really covering, and everything that reaches here is a
    // live RPC failure. Swallowing one and returning 0 wraps the signature for
    // whoever holds slot 0, which the account rejects on chain with an opaque
    // revert. Letting it propagate makes it a diagnosable error at the call site.
    return (await scanOwnerIndex({ address, client, publicKey })) ?? 0;
}

/**
 * Formats 20 byte addresses to 32 byte public keys. Contract uses 32 byte keys for owners.
 * @param publicKey - The public key to format
 * @returns The formatted public key
 */
export function formatPublicKey(publicKey: Hex): Hex {
    if (isAddress(publicKey)) {
        return pad(publicKey);
    }
    return publicKey;
}

/**
 * Create a temporary SmartAccount instance for signing on behalf of a different account.
 * Verifies the signer is a registered owner on the target account.
 */
export async function createSmartAccountForAddress(
    targetAddress: Address,
    account: WebAuthnAccount | LocalAccount,
    bundlerClient: JustanAccountImplementation['client']
): Promise<SmartAccount> {
    const ownerBytes: Hex = account.type === 'webAuthn' ? account.publicKey : account.address;

    const code = await getCode(bundlerClient, { address: targetAddress });
    if (!code) {
        throw standardErrors.rpc.invalidParams(`Account ${targetAddress} is not deployed`);
    }

    const ownerIndex = await scanOwnerIndex({
        address: targetAddress,
        client: bundlerClient,
        publicKey: ownerBytes,
    });

    if (ownerIndex === undefined) {
        throw standardErrors.rpc.invalidParams(`Signer is not an owner on account ${targetAddress}`);
    }

    return await toJustanAccount({
        client: bundlerClient,
        owners: [account, PERMISSIONS_MANAGER_ADDRESS],
        ownerIndex,
        address: targetAddress,
    });
}

export async function createSmartAccountEip7702(
    localAccount: LocalAccount,
    bundlerClient: JustanAccountImplementation['client']
): Promise<SmartAccount> {
    return await toJustanAccount({
        client: bundlerClient,
        owners: [localAccount, PERMISSIONS_MANAGER_ADDRESS],
        eip7702Account: localAccount,
    });
}

export async function calculateGas(chain: Chain, gas: bigint, paymasterUrlOverride?: string): Promise<string> {
    const bundlerClient = getBundlerClient(chain, paymasterUrlOverride);
    const gasPrice = await getGasPrice(bundlerClient);
    const result = formatUnits(gas * gasPrice, 18);
    return result;
}

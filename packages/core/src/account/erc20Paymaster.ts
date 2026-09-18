import { Address, Hex, createPublicClient, encodeFunctionData, erc20Abi, formatUnits, getAddress } from 'viem';
import { SmartAccount, entryPoint08Address } from 'viem/account-abstraction';
import { getBundlerClient } from './smartAccount.js';
import { Chain, getClient, store } from '../store/index.js';
import { ERC20_PAYMASTER_ADDRESS, JAW_PROXY_URL, PERMISSIONS_MANAGER_ADDRESS } from '../constants.js';
import {
    getPermissionFromRelay,
    relayPermissionToPermission,
    encodeExecuteBatchWithPermission,
} from '../rpc/permissions.js';
import { simulateUserOpGasUsage, type MeasuredUserOpGas } from './userOpGasSimulation.js';
import { jawHttp } from '../utils/jawHttp.js';

/**
 * Token quote from Pimlico's ERC-20 paymaster
 */
export interface TokenQuote {
    tokenAddress: Address;
    postOpGas: bigint;
    exchangeRate: bigint;
    paymasterAddress: Address;
}

/**
 * Estimated cost for a token
 */
export interface TokenEstimate {
    tokenAddress: Address;
    symbol: string;
    decimals: number;
    /**
     * Realistic expected cost, for display. Uses the paymaster's own quoted postOp
     * gas (not the padded stub limit) priced at the effective gas price when
     * available. Always <= tokenCostMax.
     */
    tokenCost: bigint;
    tokenCostFormatted: string;
    /**
     * Worst-case ceiling: the maximum the paymaster can charge for this userOp
     * (full gas limits at maxFeePerGas). This is the amount to approve and the
     * amount the balance must cover.
     */
    tokenCostMax: bigint;
    tokenCostMaxFormatted: string;
    paymasterAddress: Address;
    exchangeRate: bigint;
    /**
     * Whether the user has sufficient balance to pay with this token.
     * Checked against tokenCostMax so a transaction is never started that could
     * fail at the paymaster's postOp transfer in the worst case.
     */
    hasSufficientBalance: boolean;
}

/**
 * Token info for estimation
 */
export interface TokenInfo {
    address: Address;
    symbol: string;
    decimals: number;
    /** User's balance in the smallest unit (wei for 18 decimals, etc.) */
    balance: bigint;
}

/**
 * Gas fields from a prepared UserOperation (EntryPoint v0.7/0.8)
 */
export interface UserOpGasFields {
    preVerificationGas: bigint;
    verificationGasLimit: bigint;
    callGasLimit: bigint;
    paymasterVerificationGasLimit?: bigint;
    paymasterPostOpGasLimit?: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas?: bigint;
}

/**
 * Buffer applied to the current base fee when pricing the displayed estimate.
 * EIP-1559 lets the base fee rise up to 12.5% per block, so 1.25x absorbs a
 * couple of rising blocks between estimation and inclusion — the shown fee lands
 * at or slightly above the real charge, never below, while staying far under the
 * ~2x ceiling that maxFeePerGas carries.
 */
const DISPLAY_BASE_FEE_BUFFER_BPS = 12500n;
const BPS_DENOMINATOR = 10000n;

/** Buffer on simulated verification gas: state drift between simulation and inclusion. */
const VERIFICATION_GAS_BUFFER_BPS = 10500n;

/** Larger execution buffer: also covers EIP-3529 refunds the simulation nets out but the EntryPoint bills. */
const EXECUTION_GAS_BUFFER_BPS = 11000n;

/** EntryPoint v0.8 charges 10% of unused callGasLimit once the gap exceeds this. */
const UNUSED_GAS_PENALTY_THRESHOLD = 40000n;

/** EntryPoint bookkeeping invisible to per-phase replay (innerHandleOp, hashing, event, fee collection). Calibrated against real Base Sepolia ops. */
const ENTRYPOINT_OVERHEAD_GAS = 25000n;

/**
 * Display gas from the simulated phases: preVerificationGas, the paymaster
 * verification limit (not simulated), buffered measured phases, EntryPoint
 * overhead, and the unused-callGas penalty (grows with bundler padding, so no
 * proportional buffer can absorb it).
 */
export function computeMeasuredDisplayGas(gas: UserOpGasFields, measured: MeasuredUserOpGas): bigint {
    const bufferedVerification = (measured.verificationGasUsed * VERIFICATION_GAS_BUFFER_BPS) / BPS_DENOMINATOR;
    const bufferedExecution = (measured.executionGasUsed * EXECUTION_GAS_BUFFER_BPS) / BPS_DENOMINATOR;

    const unusedCallGas =
        gas.callGasLimit > measured.executionGasUsed ? gas.callGasLimit - measured.executionGasUsed : 0n;
    const penalty = unusedCallGas > UNUSED_GAS_PENALTY_THRESHOLD ? unusedCallGas / 10n : 0n;

    return (
        gas.preVerificationGas +
        (gas.paymasterVerificationGasLimit || 0n) +
        bufferedVerification +
        bufferedExecution +
        ENTRYPOINT_OVERHEAD_GAS +
        penalty
    );
}

/**
 * Effective gas price for the displayed estimate.
 *
 * The paymaster charges in postOp at the price the EntryPoint settles at —
 * `min(maxFeePerGas, baseFee + maxPriorityFeePerGas)` — NOT the maxFeePerGas
 * ceiling. Pricing the display at a buffered base fee + priority tracks the real
 * charge closely; the result is capped at maxFeePerGas since the settle price
 * can never exceed the userOp's own ceiling.
 */
export function computeEffectiveGasPrice(
    gas: Pick<UserOpGasFields, 'maxFeePerGas' | 'maxPriorityFeePerGas'>,
    baseFeePerGas: bigint,
    bufferBps: bigint = DISPLAY_BASE_FEE_BUFFER_BPS
): bigint {
    const priority = gas.maxPriorityFeePerGas ?? 0n;
    const buffered = (baseFeePerGas * bufferBps) / BPS_DENOMINATOR + priority;
    return buffered < gas.maxFeePerGas ? buffered : gas.maxFeePerGas;
}

/**
 * Fetches token quotes from Pimlico's ERC-20 paymaster.
 * This gets the exchange rate and postOpGas for each token.
 *
 * @param paymasterUrl - The paymaster URL (e.g., JAW_PAYMASTER_URL with chainId)
 * @param chainId - The chain ID
 * @param tokens - Array of token addresses to get quotes for
 * @returns Array of token quotes with exchange rates
 */
export async function fetchTokenQuotes(
    paymasterUrl: string,
    chainId: number,
    tokens: Address[]
): Promise<TokenQuote[]> {
    // Pimlico expects:
    // - id as a number (not UUID string)
    // - params as [{tokens: [...]}, entryPointAddress, chainIdHex]
    const requestBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'pimlico_getTokenQuotes',
        params: [{ tokens }, entryPoint08Address, `0x${chainId.toString(16)}`],
    };

    // Calls made from the keys origin all carry the same `Origin`, so the caller
    // they act on behalf of travels alongside instead of in it. Only to our own
    // proxy: a paymaster url an app-specific dApp points elsewhere belongs to
    // somebody else, and which dApp the user is on is not theirs to be told.
    const dappOrigin = paymasterUrl.startsWith(JAW_PROXY_URL) ? store.config.get().dappOrigin : undefined;

    const response = await fetch(paymasterUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(dappOrigin ? { 'x-dapp-origin': dappOrigin } : {}),
        },
        body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    if (data.error) {
        throw new Error(`pimlico_getTokenQuotes error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    const result = data.result;
    if (!result?.quotes || !Array.isArray(result.quotes)) {
        throw new Error('Invalid response from pimlico_getTokenQuotes: no quotes array');
    }

    const quotes = result.quotes.map(
        (q: { token: string; postOpGas: string; exchangeRate: string; paymaster: string }) => ({
            tokenAddress: q.token as Address,
            postOpGas: BigInt(q.postOpGas),
            exchangeRate: BigInt(q.exchangeRate),
            paymasterAddress: q.paymaster as Address,
        })
    );

    return quotes;
}

/**
 * Estimates ERC-20 paymaster costs for multiple tokens.
 * This:
 * 1. Gets token quotes from the paymaster
 * 2. Prepares a UserOp WITH the paymaster (so estimation works without ETH)
 * 3. Calculates the token cost for each using Pimlico's formula
 *
 * When `permissionId` is provided, calls are routed through the permissions manager
 *
 * @param smartAccount - The smart account to estimate for
 * @param calls - Array of transaction calls (user's intended transactions)
 * @param chain - The chain configuration
 * @param paymasterUrl - The ERC-20 paymaster URL
 * @param tokens - Array of tokens to estimate costs for
 * @param options - Optional permission-based execution context
 * @returns Array of token estimates with costs
 */
export async function estimateErc20PaymasterCosts(
    smartAccount: SmartAccount,
    calls: Array<{ to: Address; value?: bigint; data?: Hex }>,
    chain: Chain,
    paymasterUrl: string,
    tokens: TokenInfo[],
    options?: { permissionId?: Hex; apiKey?: string }
): Promise<TokenEstimate[]> {
    if (tokens.length === 0) {
        return [];
    }

    // 1. Get quotes for all tokens in one call
    const tokenAddresses = tokens.map((t) => t.address);
    const quotes = await fetchTokenQuotes(paymasterUrl, chain.id, tokenAddresses);

    if (quotes.length === 0) {
        throw new Error('No token quotes returned from paymaster');
    }

    // 2. Build calls with dummy approval for estimation
    // Use MaxUint256 for approval - amount doesn't affect gas estimation
    const MaxUint256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

    // Use the first quote's paymaster address (should be same for all)
    const paymasterAddress = quotes[0]?.paymasterAddress || ERC20_PAYMASTER_ADDRESS;

    // Create a dummy approval call (we'll use the first token for estimation)
    // Gas cost is similar regardless of which token we approve
    const approvalCall = {
        to: tokens[0].address,
        value: 0n,
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [paymasterAddress, MaxUint256],
        }),
    };

    // For permission-based execution, the user's calls cannot go to their targets
    // directly — they must be routed through the permissions manager.
    let preparedCalls: Array<{ to: Address; value: bigint; data: Hex }>;
    if (options?.permissionId) {
        const relayPermission = await getPermissionFromRelay(options.permissionId, options.apiKey);
        const permission = relayPermissionToPermission(relayPermission);

        const formattedCalls = calls.map((call) => ({
            target: getAddress(call.to),
            value: call.value ?? 0n,
            data: call.data ?? ('0x' as Hex),
        }));

        const encodedData = encodeExecuteBatchWithPermission(permission, formattedCalls);

        preparedCalls = [
            approvalCall,
            {
                to: getAddress(PERMISSIONS_MANAGER_ADDRESS),
                value: 0n,
                data: encodedData,
            },
        ];
    } else {
        preparedCalls = [
            approvalCall,
            ...calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? ('0x' as Hex) })),
        ];
    }

    // 3. Prepare UserOp WITH the paymaster configured
    // This is key - the paymaster being included means estimation won't fail with AA21
    const bundlerClient = getBundlerClient(chain, paymasterUrl, { token: tokens[0].address });

    // Fire the base-fee fetch in parallel with the userOp preparation — the two are
    // independent and the block is only consumed after the userOp resolves. Reuse the
    // cached per-chain client when the chain is registered in the store. Best-effort:
    // without a base fee the display falls back to the ceiling price.
    const publicClient = getClient(chain.id) ?? createPublicClient({ transport: jawHttp(chain.rpcUrl) });
    const blockPromise = publicClient.getBlock({ blockTag: 'latest' }).catch(() => null);

    const userOp = await bundlerClient.prepareUserOperation({
        account: smartAccount,
        calls: preparedCalls,
    });

    // 4. Extract gas fields from userOp
    const gas: UserOpGasFields = {
        preVerificationGas: userOp.preVerificationGas,
        verificationGasLimit: userOp.verificationGasLimit,
        callGasLimit: userOp.callGasLimit,
        paymasterVerificationGasLimit:
            'paymasterVerificationGasLimit' in userOp
                ? (userOp as { paymasterVerificationGasLimit?: bigint }).paymasterVerificationGasLimit
                : undefined,
        paymasterPostOpGasLimit:
            'paymasterPostOpGasLimit' in userOp
                ? (userOp as { paymasterPostOpGasLimit?: bigint }).paymasterPostOpGasLimit
                : undefined,
        maxFeePerGas: userOp.maxFeePerGas,
        maxPriorityFeePerGas: userOp.maxPriorityFeePerGas,
    };

    // 5. Replay the userOp phases against current state to measure the gas they
    // really consume — the padded limits stay as the fallback (and the ceiling).
    // No retries + short timeout so a node without eth_simulateV1 can't stall the
    // fee estimate (viem would otherwise retry up to ~40s on every refetch).
    const simClient = createPublicClient({ transport: jawHttp(chain.rpcUrl, { retryCount: 0, timeout: 2_500 }) });
    const measuredPromise = simulateUserOpGasUsage(simClient, userOp, smartAccount.entryPoint.address);

    // 6. Price the displayed estimate at the effective gas price instead of the
    // maxFeePerGas ceiling, using the base fee fetched above.
    let displayGasPrice: bigint | undefined;
    const [block, measured] = await Promise.all([blockPromise, measuredPromise]);
    if (block?.baseFeePerGas != null && block.baseFeePerGas > 0n) {
        displayGasPrice = computeEffectiveGasPrice(gas, block.baseFeePerGas);
    }
    const measuredGas = measured ? computeMeasuredDisplayGas(gas, measured) : undefined;

    // 7. Calculate cost for each token using the utility function
    return calculateTokenEstimatesFromGas(gas, quotes, tokens, { displayGasPrice, measuredGas });
}

/** Sum of the userOp gas limits shared by every cost formula (all phases except postOp). */
function sumGasLimitsExceptPostOp(gas: UserOpGasFields): bigint {
    return (
        gas.preVerificationGas + gas.verificationGasLimit + gas.callGasLimit + (gas.paymasterVerificationGasLimit || 0n)
    );
}

/**
 * Calculates the required prefund (total gas cost in wei) from userOp gas fields.
 * This follows Pimlico's getRequiredPrefund formula for EntryPoint v0.7/0.8.
 */
export function getRequiredPrefund(gas: UserOpGasFields): bigint {
    const totalGas = sumGasLimitsExceptPostOp(gas) + (gas.paymasterPostOpGasLimit || 0n);

    return totalGas * gas.maxFeePerGas;
}

/**
 * Calculates the worst-case token cost (ceiling) for a userOp.
 *
 * This mirrors the maximum the singleton paymaster can charge in postOp:
 * `costInToken = (actualGasCost + postOpGas * actualFee) * exchangeRate / 1e18`,
 * where actualGasCost is bounded by the full prefund (ALL five gas limits,
 * including paymasterPostOpGasLimit) and actualFee by maxFeePerGas. postOpGas is
 * added ON TOP by the contract (it can't measure its own token transfer), so it
 * appears here in addition to the postOp limit — that is not a double count for
 * the ceiling, it's the contract's exact worst case.
 *
 * Use this for the approval amount and the balance check. For the fee shown to
 * the user, use calculateDisplayTokenCost.
 *
 * @param gas - Gas fields from a prepared userOp
 * @param quote - Token quote from fetchTokenQuotes
 * @returns Worst-case token cost in the token's smallest unit
 */
export function calculateTokenCostFromGas(gas: UserOpGasFields, quote: TokenQuote): bigint {
    const totalGas = sumGasLimitsExceptPostOp(gas) + (gas.paymasterPostOpGasLimit || 0n) + quote.postOpGas;

    const maxCostWei = totalGas * gas.maxFeePerGas;

    return (maxCostWei * quote.exchangeRate) / BigInt(1e18);
}

/**
 * Calculates the realistic token cost for display.
 *
 * Differs from the ceiling in two ways:
 * - counts the postOp phase once, via the paymaster's own quoted real postOp gas
 *   (`quote.postOpGas`), instead of also including the padded
 *   `paymasterPostOpGasLimit` stub — the real postOp can't exceed what the
 *   paymaster itself quotes;
 * - prices at `gasPrice` (the effective price when available) instead of the
 *   maxFeePerGas ceiling.
 *
 * @param gas - Gas fields from a prepared userOp
 * @param quote - Token quote from fetchTokenQuotes
 * @param opts.gasPrice - Price per gas for the estimate (defaults to maxFeePerGas)
 * @param opts.measuredGas - Simulated real gas usage (except postOp); replaces the summed limits
 * @returns Expected token cost in the token's smallest unit
 */
export function calculateDisplayTokenCost(
    gas: UserOpGasFields,
    quote: TokenQuote,
    opts?: { gasPrice?: bigint; measuredGas?: bigint }
): bigint {
    // Structurally bounded: should a quote ever exceed the userOp's own postOp
    // limit, the limit wins — the display can never leapfrog the ceiling.
    const postOpGas =
        gas.paymasterPostOpGasLimit != null && gas.paymasterPostOpGasLimit < quote.postOpGas
            ? gas.paymasterPostOpGasLimit
            : quote.postOpGas;

    const totalGas = (opts?.measuredGas ?? sumGasLimitsExceptPostOp(gas)) + postOpGas;

    const costWei = totalGas * (opts?.gasPrice ?? gas.maxFeePerGas);

    return (costWei * quote.exchangeRate) / BigInt(1e18);
}

/**
 * Calculates token estimates from existing gas data and quotes.
 * Use this when you already have a prepared userOp and quotes to avoid redundant API calls.
 *
 * @param gas - Gas fields from a prepared userOp
 * @param quotes - Token quotes from fetchTokenQuotes
 * @param tokens - Token info (for symbol, decimals, balance)
 * @returns Array of token estimates
 */
export function calculateTokenEstimatesFromGas(
    gas: UserOpGasFields,
    quotes: TokenQuote[],
    tokens: TokenInfo[],
    opts?: { displayGasPrice?: bigint; measuredGas?: bigint }
): TokenEstimate[] {
    return quotes.map((quote) => {
        const token = tokens.find((t) => t.address.toLowerCase() === quote.tokenAddress.toLowerCase());
        const decimals = token?.decimals ?? 18;
        const symbol = token?.symbol || 'UNKNOWN';
        const balance = token?.balance || 0n;

        const tokenCostMax = calculateTokenCostFromGas(gas, quote);
        let tokenCost = calculateDisplayTokenCost(gas, quote, {
            gasPrice: opts?.displayGasPrice,
            measuredGas: opts?.measuredGas,
        });
        // The shown estimate can never exceed the ceiling being reserved.
        if (tokenCost > tokenCostMax) tokenCost = tokenCostMax;

        const hasSufficientBalance = balance >= tokenCostMax;
        const tokenCostFormatted = formatTokenAmount(tokenCost, decimals);
        const tokenCostMaxFormatted = formatTokenAmount(tokenCostMax, decimals);

        return {
            tokenAddress: quote.tokenAddress,
            symbol,
            decimals,
            tokenCost,
            tokenCostFormatted,
            tokenCostMax,
            tokenCostMaxFormatted,
            paymasterAddress: quote.paymasterAddress,
            exchangeRate: quote.exchangeRate,
            hasSufficientBalance,
        };
    });
}

/**
 * Builds the paymaster context for paying gas with an estimated ERC-20 token.
 *
 * `gas` is the amount the bundled approval must cover: the worst-case ceiling
 * (`tokenCostMax`), NOT the displayed estimate — the paymaster's postOp can
 * charge up to the ceiling, and an insufficient allowance reverts the whole
 * operation. Every UI that lets a user pay in ERC-20 should build its
 * paymaster context through this helper so the rule lives in one place.
 */
export function buildErc20PaymasterContext(estimate: TokenEstimate): { token: Address; gas: string } {
    return {
        token: estimate.tokenAddress,
        gas: estimate.tokenCostMax.toString(),
    };
}

/**
 * Encodes an ERC-20 approval call for the paymaster.
 *
 * @param tokenAddress - The ERC-20 token to approve
 * @param spender - The paymaster address to approve
 * @param amount - The amount to approve (in token's smallest unit)
 * @returns The encoded call data
 */
export function encodeApprovalCall(
    tokenAddress: Address,
    spender: Address,
    amount: bigint
): { to: Address; value: bigint; data: Hex } {
    return {
        to: tokenAddress,
        value: 0n,
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [spender, amount],
        }),
    };
}

/**
 * Formats a token amount for display.
 * Shows up to 4 decimal places for amounts < 1, 2 decimal places otherwise.
 */
function formatTokenAmount(amount: bigint, decimals: number): string {
    const formatted = formatUnits(amount, decimals);
    const num = parseFloat(formatted);

    if (num === 0) return '0';
    if (num < 1) return num.toFixed(4);
    return num.toFixed(2);
}

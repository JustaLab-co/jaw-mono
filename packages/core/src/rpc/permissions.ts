import {
    encodeFunctionData,
    type Address,
    type Hex,
    decodeEventLog,
    toFunctionSelector,
    zeroAddress as ZERO_ADDRESS,
} from 'viem';
import { getTransactionReceipt } from 'viem/actions';
import { PERMISSIONS_MANAGER_ADDRESS, JAW_RPC_URL, JAW_PROXY_URL } from '../constants.js';
import { sendTransaction, getBundlerClient } from '../account/smartAccount.js';
import { SmartAccount } from 'viem/account-abstraction';
import { Chain } from '../store/index.js';
import { standardErrors } from '../errors/errors.js';
import { restCall } from '../api/index.js';
import { buildHandleJawRpcUrl, fetchRPCRequest } from '../utils/index.js';
import type { RequestArguments } from '../provider/index.js';
import { optionalHexAddress, requireHexBytes32, requireParamsObject } from './paramUtils.js';

/**
 * ERC-7528 native token address convention
 * @see https://eips.ethereum.org/EIPS/eip-7528
 */
export const NATIVE_TOKEN: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * Wildcard constants for call permissions (from JustaPermissionManager contract)
 * @see JustaPermissionManager.sol for detailed usage
 */
export const ANY_TARGET: Address = '0x3232323232323232323232323232323232323232';
export const ANY_FN_SEL: Hex = '0x32323232';
export const EMPTY_CALLDATA_FN_SEL: Hex = '0xe0e0e0e0';

/**
 * Period type for spend limits - matches the SpendPeriod enum in the contract
 */
export type SpendPeriod = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' | 'forever';

/**
 * Compute function selector from function signature
 * @param signature - Function signature (e.g., "transfer(address,uint256)")
 * @returns 4-byte function selector (e.g., "0xa9059cbb")
 *
 * @example
 * ```typescript
 * const selector = computeFunctionSelector("transfer(address,uint256)");
 * // Returns: "0xa9059cbb"
 * ```
 */
export function computeFunctionSelector(signature: string): Hex {
    return toFunctionSelector(signature);
}

/**
 * Call permission for executing specific functions
 */
export type CallPermission = {
    /** Target contract address */
    target: Address;
    /** Function selector (4 bytes) */
    selector: Hex;
    /** External validation contract address (internal only - defaults to zero address) */
    checker: Address;
};

/**
 * Spend limit with recurring periods
 */
export type SpendLimit = {
    /** Token address (ERC-7528 native token or ERC-20 contract) */
    token: Address;
    /** Maximum allowed value to spend within each period */
    allowance: bigint;
    /** Period unit (minute, hour, day, week, month, year, forever) */
    unit: SpendPeriod;
    /** Multiplier for the period unit (1-65535, uint16) */
    multiplier: number;
};

/**
 * Permission struct matching the Solidity contract
 */
export type Permission = {
    /** Smart account this permission is valid for */
    account: Address;
    /** Entity that can use this permission */
    spender: Address;
    /** Timestamp this permission is valid starting at (inclusive, unix seconds) */
    start: number;
    /** Timestamp this permission is valid until (exclusive, unix seconds) */
    end: number;
    /** Arbitrary data to differentiate unique permissions with otherwise identical fields */
    salt: bigint;
    /** Array of call permissions */
    calls: CallPermission[];
    /** Array of spend limits */
    spends: SpendLimit[];
};

/**
 * Spend permission detail for API request/response
 */
export type SpendPermissionDetail = {
    /** Token address */
    token: Address;
    /** Spending allowance in wei (decimal or hex string) */
    allowance: string;
    /** Period unit of the spend limit */
    unit: SpendPeriod;
    /** Multiplier for the period (1-255), defaults to 1 */
    multiplier?: number;
};

/**
 * Call permission detail for API request/response
 */
export type CallPermissionDetail = {
    /** Target contract address */
    target: Address;
    /** Function selector (4 bytes, hex format) - computed from functionSignature if not provided */
    selector?: Hex;
    /** Human-readable function signature (e.g., "transfer(address,uint256)") */
    functionSignature?: string;
};

/**
 * Permissions detail structure
 */
export type PermissionsDetail = {
    /** Optional array of call permissions */
    calls?: CallPermissionDetail[];
    /** Optional array of spend permissions */
    spends?: SpendPermissionDetail[];
};

/**
 * EIP-5792 Paymaster Service capability
 * Allows dApps to specify a paymaster URL for sponsored transactions
 * @see https://eips.ethereum.org/EIPS/eip-5792
 * @see https://www.eip5792.xyz/capabilities/paymasterService
 */
export type PaymasterServiceCapability = {
    /** URL of the paymaster service (ERC-7677 compliant) */
    url: string;
    /** Context of the paymaster service */
    context?: Record<string, unknown>;
    /** Optional flag indicating if paymaster is optional (transaction can proceed without it) */
    optional?: boolean;
};

/**
 * Permissions capability for wallet_sendCalls
 */
export type PermissionsCapability = {
    /** ID of the permission to use for execution */
    id: `0x${string}`;
};

/**
 * Request capabilities for wallet methods
 * Used in wallet_sendCalls, wallet_grantPermissions, wallet_revokePermissions
 */
export type RequestCapabilities = {
    /** Paymaster service for sponsored transactions */
    paymasterService?: PaymasterServiceCapability;
    /** Permissions capability for wallet_sendCalls */
    permissions?: PermissionsCapability;
    /**
     * On `wallet_grantPermissions`, send a small amount of the permission's own
     * spend token to the spender in the same transaction, so its first userOp
     * can pay its own fee. The wallet decides the amount; the request only asks.
     */
    prefundSpender?: boolean;
    /** Additional capabilities can be added here */
    [key: string]: unknown;
};

/**
 * Request parameters for wallet_grantPermissions
 */
export type WalletGrantPermissionsRequest = {
    method: 'wallet_grantPermissions';
    params: [
        {
            /** Timestamp this permission is valid until (exclusive, unix seconds) */
            expiry: number;
            /** Spender address */
            spender: Address;
            /** Permissions details */
            permissions: PermissionsDetail;
            /** Override account address — grant permission on a different account this passkey owns */
            address?: Address;
            /** Target chain ID. Defaults to the connected chain. */
            chainId?: string;
            /** Optional capabilities including paymaster service */
            capabilities?: RequestCapabilities;
        },
    ];
};

/**
 * Request to store a permission in the relay
 */
export type StorePermissionApiRequest = {
    /** Permission ID (hash from the contract) */
    permissionId: string;
    /** Account address */
    account: string;
    /** Spender address */
    spender: string;
    /** Start timestamp (unix seconds as number) */
    start: number;
    /** End timestamp (unix seconds as number) */
    end: number;
    /** Salt for uniqueness (hex format) */
    salt: Hex;
    /** Array of call permissions */
    calls: Array<{
        target: string;
        selector: string;
        checker?: string;
    }>;
    /** Array of spend limits */
    spends: Array<{
        token: string;
        allowance: string;
        unit: SpendPeriod;
        multiplier: number;
    }>;
    /** Chain ID (hex format) */
    chainId: string;
};

/**
 * Response from the JAW RPC relay when storing a permission
 */
export type StorePermissionApiResponse = StorePermissionApiRequest;

/**
 * Response from wallet_getPermissions
 * Returns an array of stored permissions
 */
export type WalletGetPermissionsResponse = StorePermissionApiResponse[];

/**
 * Response from wallet_grantPermissions (returned to dApp)
 * Contains the full Permission struct matching the JustaPermissionManager contract,
 * plus additional metadata (permissionId, chainId).
 * Uses JSON-serializable types (strings instead of bigint).
 */
export type WalletGrantPermissionsResponse = {
    /** Smart account this permission is valid for */
    account: Address;
    /** Entity that can use this permission */
    spender: Address;
    /** Timestamp (in seconds) that specifies when this permission becomes valid */
    start: number;
    /** Timestamp (in seconds) that specifies the time by which this permission expires */
    end: number;
    /** Salt used for permission uniqueness (as hex string) */
    salt: Hex;
    /** Array of call permissions */
    calls: CallPermissionDetail[];
    /** Array of spend permissions */
    spends: SpendPermissionDetail[];
    /** Permission identifier - the permission hash from the contract */
    permissionId: Hex;
    /** Chain ID in hex format */
    chainId: Hex;
};

/**
 * Response when revoking a permission
 */
export type RevokePermissionApiResponse = {
    /** Indicates if the permission was revoked successfully */
    success: boolean;
};

/**
 * Request parameters for wallet_revokePermissions
 */
export type WalletRevokePermissionsRequest = {
    method: 'wallet_revokePermissions';
    params: [
        {
            /** Address of the account to revoke a permission on */
            address?: Address;
            /** ID of the permission to revoke (permission hash from contract) */
            id: Hex;
            /** Optional capabilities including paymaster service */
            capabilities?: RequestCapabilities;
        },
    ];
};

const REVOKE_METHOD = 'wallet_revokePermissions';

/** A wallet_revokePermissions request after validation: the id is guaranteed present. */
export interface NormalizedRevokePermissionsParams {
    /** The permission hash to revoke. */
    id: `0x${string}`;
    /** Account to revoke on; the signer's own when the dapp leaves it out. */
    address?: Address;
    capabilities?: RequestCapabilities;
}

/**
 * Validates wallet_revokePermissions params.
 *
 * The revocation is built entirely from the stored permission, so without a
 * usable id there is nothing to sign. Both signers used to guard this with
 * `if (permissionId)`, which skipped the check for the one input that most
 * needs it — an empty id then reached the UI, which rendered an empty
 * permission and offered to sign it. Refusing here means the dapp gets
 * `-32602` before any popup or dialog opens.
 */
export function normalizeRevokePermissionsParams(params: unknown): NormalizedRevokePermissionsParams {
    const envelope = requireParamsObject(params, REVOKE_METHOD);
    return {
        id: requireHexBytes32(envelope.id, REVOKE_METHOD, 'id'),
        address: optionalHexAddress(envelope.address, REVOKE_METHOD, 'address'),
        capabilities: envelope.capabilities as RequestCapabilities | undefined,
    };
}

/**
 * Grant permissions by approving on-chain, then storing in relay
 *
 * This function:
 * 1. Converts API permissions to Permission struct
 * 2. Approves the permission on-chain (which returns the hash)
 * 3. Extracts the permission hash from the PermissionApproved event
 * 4. Stores the permission in the relay
 * 5. Returns the response to the dApp with the hash as permission ID
 *
 * @param smartAccount - Smart account to execute the approve transaction
 * @param expiry - Timestamp when the permission expires
 * @param spender - Address that will be granted the permissions
 * @param permissions - Permissions detail (calls and spends)
 * @param chain - Chain configuration
 * @param apiKey - API key for relay authentication
 * @param paymasterUrlOverride - Optional paymaster URL that overrides chain.paymasterUrl
 * @param prependCalls - Calls to execute ahead of the approval, in the same
 * transaction. The caller decides what belongs there and in what order; this
 * function only puts the approval last. A single call is still accepted, which
 * is the shape this parameter had when it only ever carried the ERC-20 approval.
 */
export async function grantPermissions(
    smartAccount: SmartAccount,
    expiry: number,
    spender: Address,
    permissions: PermissionsDetail,
    chain: Chain,
    apiKey: string | undefined,
    paymasterUrlOverride?: string,
    paymasterContextOverride?: Record<string, unknown>,
    prependCalls?: { to: Address; value?: bigint; data?: Hex } | Array<{ to: Address; value?: bigint; data?: Hex }>
): Promise<WalletGrantPermissionsResponse> {
    // Refused here, before anything reaches the chain, because a grant has two
    // legs that fail in opposite directions. The approval goes out first and the
    // relay stores it second, so a relay call refused for want of a key leaves a
    // permission approved on chain and absent from the record every reader goes
    // through: `getPermission`, and every session resolving what it may spend.
    // The chain says approved, the product says nothing exists, and only a
    // revoke the user does not know to make would clear it.
    //
    // Unreachable while a caller with no key cannot reach the proxy at all,
    // since the first leg fails first. It becomes reachable the moment requests
    // are served without one.
    if (!apiKey) {
        throw new Error(
            'apiKey is required to grant a permission. The approval is sent on chain before the relay stores it, ' +
                'so granting without one would leave a permission approved and unreadable.'
        );
    }

    // Derive address and chainId from smart account and chain
    const account = smartAccount.address;
    const chainId = `0x${chain.id.toString(16)}` as Hex;

    const permission = apiPermissionsToPermission(account, spender, expiry, permissions);

    const approveCallData = encodeApprovePermission(permission);

    const permissionCall = { to: PERMISSIONS_MANAGER_ADDRESS as Address, data: approveCallData };
    const prepend = prependCalls ? (Array.isArray(prependCalls) ? prependCalls : [prependCalls]) : [];
    const calls: Array<{ to: Address; value?: bigint; data?: Hex }> = [...prepend, permissionCall];

    const txHash = await sendTransaction(
        smartAccount,
        calls,
        chain,
        paymasterUrlOverride,
        paymasterContextOverride,
        apiKey
    );

    // Extract the permission hash from the PermissionApproved event
    const permissionHash = await extractPermissionHashFromTransaction(txHash, chain);

    await storePermissionInRelay(permissionHash, permission, chainId, apiKey);

    // Convert internal Permission to JSON-serializable response format
    const responseCalls: CallPermissionDetail[] = permission.calls.map((call) => ({
        target: call.target,
        selector: call.selector,
    }));

    const responseSpends: SpendPermissionDetail[] = permission.spends.map((spend) => ({
        token: spend.token,
        allowance: `0x${spend.allowance.toString(16)}`,
        unit: spend.unit,
        multiplier: spend.multiplier,
    }));

    return {
        account,
        spender,
        start: permission.start,
        end: permission.end,
        salt: `0x${permission.salt.toString(16)}` as Hex,
        calls: responseCalls,
        spends: responseSpends,
        permissionId: permissionHash,
        chainId: chainId as Hex,
    };
}

/**
 * Revoke a permission by its ID (permission hash)
 *
 * This function:
 * 1. Fetches the permission data from the relay
 * 2. Reconstructs the Permission struct
 * 3. Executes the revoke transaction on-chain
 * 4. Deletes the permission from the relay
 *
 * @param smartAccount - Smart account to execute the revoke transaction
 * @param permissionId - The permission hash/ID to revoke
 * @param chain - Chain configuration
 * @param apiKey - API key for relay authentication
 * @param paymasterUrlOverride - Optional paymaster URL that overrides chain.paymasterUrl
 * @param paymasterContextOverride - Optional paymaster context (e.g., token address for ERC-20 payment)
 * @param erc20ApprovalCall - Optional ERC-20 approval call to prepend for paymaster
 * @returns Response from the relay indicating success
 */
export async function revokePermission(
    smartAccount: SmartAccount,
    permissionId: Hex,
    chain: Chain,
    apiKey: string | undefined,
    paymasterUrlOverride?: string,
    paymasterContextOverride?: Record<string, unknown>,
    erc20ApprovalCall?: { to: Address; value?: bigint; data: Hex }
): Promise<RevokePermissionApiResponse> {
    const relayPermission = await getPermissionFromRelay(permissionId, apiKey);

    const permission = relayPermissionToPermission(relayPermission);

    const revokeCallData = encodeRevokePermission(permission);

    // Build calls array - prepend ERC-20 approval if provided
    const revokeCall = { to: PERMISSIONS_MANAGER_ADDRESS as Address, data: revokeCallData };
    const calls: Array<{ to: Address; value?: bigint; data?: Hex }> = erc20ApprovalCall
        ? [erc20ApprovalCall, revokeCall]
        : [revokeCall];

    await sendTransaction(smartAccount, calls, chain, paymasterUrlOverride, paymasterContextOverride, apiKey);

    return await deletePermissionFromRelay(permissionId, apiKey);
}

/**
 * Get permission from the relay using typed REST API call with path params
 */
export async function getPermissionFromRelay(
    permissionHash: Hex,
    apiKey?: string
): Promise<StorePermissionApiResponse> {
    const permissionsBaseUrl = JAW_PROXY_URL;

    return await restCall(
        'GET_PERMISSION',
        'GET',
        {},
        apiKey ? { 'x-api-key': apiKey } : {},
        { hash: permissionHash },
        undefined,
        permissionsBaseUrl
    );
}

/**
 * Convert relay permission data to Permission struct
 */
export function relayPermissionToPermission(relayPermission: StorePermissionApiResponse): Permission {
    const calls: CallPermission[] = relayPermission.calls.map((call) => ({
        target: call.target as Address,
        selector: call.selector as Hex,
        checker: (call.checker as Address) || ZERO_ADDRESS,
    }));

    const spends: SpendLimit[] = relayPermission.spends.map((spend) => ({
        token: spend.token as Address,
        allowance: BigInt(spend.allowance),
        unit: spend.unit,
        multiplier: spend.multiplier,
    }));

    return {
        account: relayPermission.account as Address,
        spender: relayPermission.spender as Address,
        start: relayPermission.start,
        end: relayPermission.end,
        salt: BigInt(relayPermission.salt),
        calls,
        spends,
    };
}

/**
 * Handle wallet_getPermissions request
 *
 * This function:
 * 1. Validates that an address is provided in params (or injects one if connectedAddress is provided)
 * 2. Calls the relay API to fetch permissions for that address
 *
 * @param request - The wallet_getPermissions request
 * @param apiKey - API key for relay authentication, if the caller has one
 * @param connectedAddress - Optional connected account address to inject if no address in params
 * @returns Permissions for the specified address
 */
export async function handleGetPermissionsRequest(
    request: RequestArguments,
    apiKey: string | undefined,
    connectedAddress?: Address
): Promise<unknown> {
    const params = request.params as Array<{ address?: Address; chainId?: string }> | undefined;

    // Determine which address to use
    let modifiedRequest = request;
    if (!params || params.length === 0 || !params[0]?.address) {
        if (connectedAddress) {
            // Inject the connected account's address
            modifiedRequest = {
                ...request,
                params: [
                    {
                        address: connectedAddress,
                        // Keep a caller-provided chain filter when injecting the address.
                        ...(params?.[0]?.chainId ? { chainId: params[0].chainId } : {}),
                    },
                ],
            };
        } else {
            // No address provided and no connected address - throw error
            throw standardErrors.rpc.invalidParams({
                message: 'wallet_getPermissions requires an address parameter',
            });
        }
    }

    const rpcUrl = buildHandleJawRpcUrl(JAW_RPC_URL, apiKey);
    return await fetchRPCRequest(modifiedRequest, rpcUrl);
}

/**
 * Convert API permissions detail to Permission struct
 */
function apiPermissionsToPermission(
    account: Address,
    spender: Address,
    expiry: number,
    permissions: PermissionsDetail
): Permission {
    const start = Math.floor(Date.now() / 1000);

    // Generate a random salt for uniqueness
    const salt = BigInt('0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''));

    // Convert call permissions - compute selector from signature if not provided
    const calls: CallPermission[] = (permissions.calls || []).map((call) => {
        let selector: Hex;

        if (call.selector) {
            // Use provided selector
            selector = call.selector;
        } else if (call.functionSignature) {
            // Compute selector from function signature
            selector = computeFunctionSelector(call.functionSignature);
        } else {
            throw standardErrors.rpc.invalidParams({
                message: 'Either selector or functionSignature must be provided for call permission',
            });
        }

        return {
            target: call.target,
            selector,
            checker: ZERO_ADDRESS,
        };
    });

    // Convert spend permissions
    const spends: SpendLimit[] = (permissions.spends || []).map((spend) => {
        // Use native token address if token is empty or undefined
        const token = spend.token && spend.token.trim() !== '' ? (spend.token as Address) : NATIVE_TOKEN;

        return {
            token,
            allowance: BigInt(spend.allowance),
            unit: spend.unit,
            multiplier: spend.multiplier ?? 1,
        };
    });

    return {
        account,
        spender,
        start,
        end: expiry,
        salt,
        calls,
        spends,
    };
}

/**
 * Store permission in the relay using typed REST API call
 */
async function storePermissionInRelay(
    permissionHash: Hex,
    permission: Permission,
    chainId: string,
    apiKey?: string
): Promise<StorePermissionApiResponse> {
    const requestData: StorePermissionApiRequest = {
        permissionId: permissionHash,
        account: permission.account,
        spender: permission.spender,
        start: permission.start,
        end: permission.end,
        salt: `0x${permission.salt.toString(16)}` as Hex,
        calls: permission.calls.map((call) => ({
            target: call.target,
            selector: call.selector,
            checker: call.checker,
        })),
        spends: permission.spends.map((spend) => ({
            token: spend.token,
            allowance: `0x${spend.allowance.toString(16)}`,
            unit: spend.unit,
            multiplier: spend.multiplier,
        })),
        chainId,
    };

    const permissionsBaseUrl = JAW_PROXY_URL;

    return await restCall(
        'STORE_PERMISSION',
        'POST',
        requestData,
        apiKey ? { 'x-api-key': apiKey } : {},
        undefined,
        undefined,
        permissionsBaseUrl
    );
}

/**
 * Delete permission from the relay using typed REST API call with path params
 */
async function deletePermissionFromRelay(permissionHash: Hex, apiKey?: string): Promise<RevokePermissionApiResponse> {
    const permissionsBaseUrl = JAW_PROXY_URL;

    return await restCall(
        'DELETE_PERMISSION',
        'DELETE',
        {},
        apiKey ? { 'x-api-key': apiKey } : {},
        { hash: permissionHash },
        undefined,
        permissionsBaseUrl
    );
}

/**
 * Extract the permission hash from the PermissionApproved event in a transaction receipt
 */
async function extractPermissionHashFromTransaction(txHash: Hex, chain: Chain): Promise<Hex> {
    const bundlerClient = getBundlerClient(chain);

    const receipt = await getTransactionReceipt(bundlerClient, {
        hash: txHash,
    });

    // Find the PermissionApproved event in the logs
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== PERMISSIONS_MANAGER_ADDRESS.toLowerCase()) {
            continue;
        }

        try {
            const decoded = decodeEventLog({
                abi: SPEND_PERMISSIONS_MANAGER_ABI,
                data: log.data,
                topics: log.topics,
            });

            if (decoded.eventName === 'PermissionApproved') {
                return decoded.args.permissionHash as Hex;
            }
        } catch {
            // Skip logs that don't match our ABI
            continue;
        }
    }

    throw standardErrors.rpc.internal({
        message: 'PermissionApproved event not found in transaction receipt',
    });
}

/**
 * Convert a Permission to the format expected by the contract ABI
 */
function permissionToContractFormat(permission: Permission) {
    return {
        ...permission,
        spends: permission.spends.map((spend) => {
            // Convert 'year' to 'month' with multiplier * 12 (contract has no Year unit)
            const unit = spend.unit === 'year' ? ('month' as const) : spend.unit;
            const multiplier = spend.unit === 'year' ? spend.multiplier * 12 : spend.multiplier;
            return {
                token: spend.token,
                allowance: spend.allowance,
                unit: periodToEnum(unit),
                multiplier,
            };
        }),
    };
}

/**
 * Encode the approve function call for JustaPermissionManager
 */
function encodeApprovePermission(permission: Permission): Hex {
    const permissionForEncoding = permissionToContractFormat(permission);

    return encodeFunctionData({
        abi: SPEND_PERMISSIONS_MANAGER_ABI,
        functionName: 'approve',
        args: [permissionForEncoding],
    });
}

/**
 * Encode the revoke function call for JustaPermissionManager
 */
function encodeRevokePermission(permission: Permission): Hex {
    const permissionForEncoding = permissionToContractFormat(permission);

    return encodeFunctionData({
        abi: SPEND_PERMISSIONS_MANAGER_ABI,
        functionName: 'revoke',
        args: [permissionForEncoding],
    });
}

/**
 * Build a transaction call for granting permissions (for gas estimation)
 *
 * This function creates a transaction call that can be used for gas estimation
 * before actually granting the permission. It uses placeholder values for
 * fields that are generated at grant time (salt, start time).
 *
 * @param account - The smart account address
 * @param spender - The spender address to grant permissions to
 * @param expiry - Timestamp when the permission expires
 * @param permissions - Permissions detail (calls and spends)
 * @returns Transaction call object with to and data fields
 */
export function buildGrantPermissionCall(
    account: Address,
    spender: Address,
    expiry: number,
    permissions: PermissionsDetail
): { to: Address; data: Hex } {
    // Create a permission with placeholder salt (gas cost is the same regardless of salt value)
    const permission = apiPermissionsToPermission(account, spender, expiry, permissions);
    const approveCallData = encodeApprovePermission(permission);

    return {
        to: PERMISSIONS_MANAGER_ADDRESS as Address,
        data: approveCallData,
    };
}

/**
 * Build a transaction call for revoking permissions (for gas estimation)
 *
 * This function creates a transaction call that can be used for gas estimation
 * before actually revoking the permission.
 *
 * @param relayPermission - The permission data from the relay
 * @returns Transaction call object with to and data fields
 */
export function buildRevokePermissionCall(relayPermission: StorePermissionApiResponse): { to: Address; data: Hex } {
    const permission = relayPermissionToPermission(relayPermission);
    const revokeCallData = encodeRevokePermission(permission);

    return {
        to: PERMISSIONS_MANAGER_ADDRESS as Address,
        data: revokeCallData,
    };
}

/**
 * Encode the executeBatch function call for JustaPermissionManager
 * This is used when executing calls using a permission
 *
 * @param permission - The permission to use for execution
 * @param calls - The calls to execute
 * @returns Encoded function data for executeBatch
 */
export function encodeExecuteBatchWithPermission(
    permission: Permission,
    calls: Array<{ target: Address; value: bigint; data: Hex }>
): Hex {
    const permissionForEncoding = permissionToContractFormat(permission);

    return encodeFunctionData({
        abi: SPEND_PERMISSIONS_MANAGER_ABI,
        functionName: 'executeBatch',
        args: [permissionForEncoding, calls],
    });
}

/**
 * Convert period string to enum value (0-6)
 * Matches the SpendPeriod enum in JustaPermissionManager contract
 */
function periodToEnum(period: Exclude<SpendPeriod, 'year'>): number {
    const periods: Record<Exclude<SpendPeriod, 'year'>, number> = {
        minute: 0,
        hour: 1,
        day: 2,
        week: 3,
        month: 4,
        forever: 5,
    };
    return periods[period];
}

/**
 * ABI for the JustaPermissionManager contract
 */
export const SPEND_PERMISSIONS_MANAGER_ABI = [
    {
        name: 'PermissionApproved',
        type: 'event',
        anonymous: false,
        inputs: [
            { name: 'permissionHash', type: 'bytes32', indexed: true },
            {
                name: 'permission',
                type: 'tuple',
                indexed: false,
                components: [
                    { name: 'account', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'start', type: 'uint48' },
                    { name: 'end', type: 'uint48' },
                    { name: 'salt', type: 'uint256' },
                    {
                        name: 'calls',
                        type: 'tuple[]',
                        components: [
                            { name: 'target', type: 'address' },
                            { name: 'selector', type: 'bytes4' },
                            { name: 'checker', type: 'address' },
                        ],
                    },
                    {
                        name: 'spends',
                        type: 'tuple[]',
                        components: [
                            { name: 'token', type: 'address' },
                            { name: 'allowance', type: 'uint160' },
                            { name: 'unit', type: 'uint8' },
                            { name: 'multiplier', type: 'uint16' },
                        ],
                    },
                ],
            },
        ],
    },
    {
        name: 'approve',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'permission',
                type: 'tuple',
                components: [
                    { name: 'account', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'start', type: 'uint48' },
                    { name: 'end', type: 'uint48' },
                    { name: 'salt', type: 'uint256' },
                    {
                        name: 'calls',
                        type: 'tuple[]',
                        components: [
                            { name: 'target', type: 'address' },
                            { name: 'selector', type: 'bytes4' },
                            { name: 'checker', type: 'address' },
                        ],
                    },
                    {
                        name: 'spends',
                        type: 'tuple[]',
                        components: [
                            { name: 'token', type: 'address' },
                            { name: 'allowance', type: 'uint160' },
                            { name: 'unit', type: 'uint8' },
                            { name: 'multiplier', type: 'uint16' },
                        ],
                    },
                ],
            },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        name: 'revoke',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'permission',
                type: 'tuple',
                components: [
                    { name: 'account', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'start', type: 'uint48' },
                    { name: 'end', type: 'uint48' },
                    { name: 'salt', type: 'uint256' },
                    {
                        name: 'calls',
                        type: 'tuple[]',
                        components: [
                            { name: 'target', type: 'address' },
                            { name: 'selector', type: 'bytes4' },
                            { name: 'checker', type: 'address' },
                        ],
                    },
                    {
                        name: 'spends',
                        type: 'tuple[]',
                        components: [
                            { name: 'token', type: 'address' },
                            { name: 'allowance', type: 'uint160' },
                            { name: 'unit', type: 'uint8' },
                            { name: 'multiplier', type: 'uint16' },
                        ],
                    },
                ],
            },
        ],
        outputs: [],
    },
    {
        name: 'executeBatch',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'permission',
                type: 'tuple',
                components: [
                    { name: 'account', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'start', type: 'uint48' },
                    { name: 'end', type: 'uint48' },
                    { name: 'salt', type: 'uint256' },
                    {
                        name: 'calls',
                        type: 'tuple[]',
                        components: [
                            { name: 'target', type: 'address' },
                            { name: 'selector', type: 'bytes4' },
                            { name: 'checker', type: 'address' },
                        ],
                    },
                    {
                        name: 'spends',
                        type: 'tuple[]',
                        components: [
                            { name: 'token', type: 'address' },
                            { name: 'allowance', type: 'uint160' },
                            { name: 'unit', type: 'uint8' },
                            { name: 'multiplier', type: 'uint16' },
                        ],
                    },
                ],
            },
            {
                name: 'calls',
                type: 'tuple[]',
                components: [
                    { name: 'target', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'data', type: 'bytes' },
                ],
            },
        ],
        outputs: [],
    },
    {
        name: 'getHash',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            {
                name: 'permission',
                type: 'tuple',
                components: [
                    { name: 'account', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'start', type: 'uint48' },
                    { name: 'end', type: 'uint48' },
                    { name: 'salt', type: 'uint256' },
                    {
                        name: 'calls',
                        type: 'tuple[]',
                        components: [
                            { name: 'target', type: 'address' },
                            { name: 'selector', type: 'bytes4' },
                            { name: 'checker', type: 'address' },
                        ],
                    },
                    {
                        name: 'spends',
                        type: 'tuple[]',
                        components: [
                            { name: 'token', type: 'address' },
                            { name: 'allowance', type: 'uint160' },
                            { name: 'unit', type: 'uint8' },
                            { name: 'multiplier', type: 'uint16' },
                        ],
                    },
                ],
            },
        ],
        outputs: [{ name: 'hash', type: 'bytes32' }],
    },
] as const;

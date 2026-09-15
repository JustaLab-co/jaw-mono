import { Address } from '../provider/interface.js';
import { RequestCapabilities } from '../rpc/permissions.js';
import type { SendCallsVersion } from '../rpc/sendCallsParams.js';
import type { JawTheme } from './theme.js';

// Re-export PermissionsCapability from permissions module for backwards compatibility
export type { PermissionsCapability } from '../rpc/permissions.js';

/**
 * UI request types that require user interaction
 */
export type UIRequestType =
    | 'wallet_connect'
    | 'wallet_sendCalls'
    | 'eth_sendTransaction'
    | 'wallet_grantPermissions'
    | 'wallet_revokePermissions'
    | 'personal_sign'
    | 'eth_signTypedData_v4'
    | 'wallet_sign'
    | 'wallet_addFunds';

/**
 * Base structure for all UI requests
 */
export interface BaseUIRequest {
    id: string;
    type: UIRequestType;
    timestamp: number;
    correlationId?: string;
}

/**
 * Connect request (wallet_connect, eth_requestAccounts)
 */
export interface ConnectUIRequest extends BaseUIRequest {
    type: 'wallet_connect';
    data: {
        appName: string;
        appLogoUrl: string | null;
        origin: string;
        chainId: number;
        capabilities?: Record<string, unknown>;
        /**
         * When true, skip the connect confirmation dialog after authentication.
         * Used for wallet_sendCalls/wallet_sign flows where the signing UI
         * will be shown immediately after account authentication/creation.
         */
        silent?: boolean;
    };
}

/**
 * Signature request (personal_sign)
 */
export interface SignatureUIRequest extends BaseUIRequest {
    type: 'personal_sign';
    data: {
        message: string;
        address: Address;
        chainId: number;
    };
}

/**
 * EIP-712 typed data signing request
 */
export interface TypedDataUIRequest extends BaseUIRequest {
    type: 'eth_signTypedData_v4';
    data: {
        typedData: string; // JSON string
        address: Address;
        chainId: number;
    };
}

/**
 * Transaction request (wallet_sendCalls)
 */
export interface TransactionUIRequest extends BaseUIRequest {
    type: 'wallet_sendCalls';
    data: {
        /**
         * EIP-5792 envelope version the dapp sent. Both are accepted and
         * handled identically: '2.0.0' is viem's (and so wagmi's) default,
         * '1.0' is the original envelope.
         */
        version: SendCallsVersion;
        from: Address;
        calls: Array<{
            to: string;
            value?: string;
            data?: string;
        }>;
        chainId: number;
        atomicRequired?: boolean;
        /** Optional capabilities including paymaster service for sponsored transactions */
        capabilities?: RequestCapabilities;
    };
}

/**
 * Legacy transaction request (eth_sendTransaction)
 * Returns a transaction hash string instead of { id, chainId }
 */
export interface SendTransactionUIRequest extends BaseUIRequest {
    type: 'eth_sendTransaction';
    data: {
        from: Address;
        to: Address;
        value?: string;
        data?: string;
        gas?: string;
        gasPrice?: string;
        maxFeePerGas?: string;
        maxPriorityFeePerGas?: string;
        nonce?: string;
        chainId: number;
        /** Optional capabilities including paymaster service for sponsored transactions */
        capabilities?: RequestCapabilities;
    };
}

/**
 * Permission grant request (wallet_grantPermissions)
 */
export interface PermissionUIRequest extends BaseUIRequest {
    type: 'wallet_grantPermissions';
    data: {
        address: Address;
        chainId: number | string; // can be hex string like '0x1'
        expiry: number;
        spender: Address;
        permissions: {
            spends?: Array<{
                token: Address;
                allowance: string;
                unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' | 'forever';
                /** Multiplier for the period (1-255), defaults to 1 */
                multiplier?: number;
            }>;
            calls?: Array<{
                target: Address;
                /** Function selector (4 bytes, hex format) - computed from functionSignature if not provided */
                selector?: `0x${string}`;
                /** Human-readable function signature (e.g., "transfer(address,uint256)") */
                functionSignature?: string;
            }>;
        };
        /** Optional capabilities including paymaster service for sponsored transactions */
        capabilities?: RequestCapabilities;
    };
}

/**
 * Permission revoke request (wallet_revokePermissions)
 */
export interface RevokePermissionUIRequest extends BaseUIRequest {
    type: 'wallet_revokePermissions';
    data: {
        permissionId: string;
        address: Address;
        chainId?: number;
        /** Optional capabilities including paymaster service for sponsored transactions */
        capabilities?: RequestCapabilities;
    };
}

/**
 * ERC-7871 PersonalSign request data
 */
export interface PersonalSignRequestData {
    type: '0x45';
    data: {
        message: string; // UTF-8 message string
    };
}

/**
 * ERC-7871 TypedData request data
 */
export interface TypedDataRequestData {
    type: '0x01';
    data: Record<string, unknown>; // TypedData as defined by EIP-712
}

/**
 * Wallet sign request (wallet_sign) - ERC-7871
 * Type 0x45 = personal sign, Type 0x01 = EIP-712 typed data
 */
export interface WalletSignUIRequest extends BaseUIRequest {
    type: 'wallet_sign';
    data: {
        address: Address;
        chainId?: number;
        request: PersonalSignRequestData | TypedDataRequestData;
    };
}

/**
 * Add Funds request (wallet_addFunds). The screen is receive-only: the chains
 * the address works on, an EIP-681 QR, and the address itself.
 *
 * `address` is the destination resolved by the wallet via `resolveDestination`,
 * never anything the dapp supplied.
 *
 * Deliberately carries no chain list. Which chains the stack shows is a display
 * decision the dialog makes from the active chain, so putting a list here would
 * mean the two hosts could hand the same screen different answers.
 *
 * Resolves when the user closes: deposits land off-app, so there is no outcome
 * to report and closing is a normal finish rather than a rejection.
 */
export interface AddFundsUIRequest extends BaseUIRequest {
    type: 'wallet_addFunds';
    data: {
        address: Address;
        /** Chain the QR pins via EIP-681. */
        chainId: number;
    };
}

/**
 * Discriminated union of all UI request types
 */
export type UIRequest =
    | ConnectUIRequest
    | SignatureUIRequest
    | TypedDataUIRequest
    | TransactionUIRequest
    | SendTransactionUIRequest
    | PermissionUIRequest
    | RevokePermissionUIRequest
    | WalletSignUIRequest
    | AddFundsUIRequest;

/**
 * UI response structure
 */
export interface UIResponse<T = unknown> {
    id: string;
    approved: boolean;
    data?: T;
    error?: UIError;
}

/**
 * UI-specific errors
 */
export enum UIErrorCode {
    USER_REJECTED = 4001,
    TIMEOUT = 4002,
    UNSUPPORTED_REQUEST = 4003,
    HANDLER_NOT_AVAILABLE = 4004,
}

export class UIError extends Error {
    code: UIErrorCode;

    constructor(code: UIErrorCode, message: string) {
        super(message);
        this.name = 'UIError';
        this.code = code;
    }

    static userRejected(message = 'User rejected the request'): UIError {
        return new UIError(UIErrorCode.USER_REJECTED, message);
    }

    static timeout(message = 'Request timed out'): UIError {
        return new UIError(UIErrorCode.TIMEOUT, message);
    }

    static unsupportedRequest(type: string): UIError {
        return new UIError(UIErrorCode.UNSUPPORTED_REQUEST, `Unsupported UI request type: ${type}`);
    }

    static handlerNotAvailable(): UIError {
        return new UIError(UIErrorCode.HANDLER_NOT_AVAILABLE, 'No UI handler available for app-specific mode');
    }
}

/**
 * Paymaster configuration for a chain
 */
import type { PaymasterConfig } from '../provider/interface.js';
export type { PaymasterConfig };

/**
 * Configuration passed to UIHandler during initialization
 * Contains SDK configuration that the UI handler may need
 */
export interface UIHandlerConfig {
    /** JAW API key for RPC URL resolution (required) */
    apiKey: string;
    /** Default chain ID */
    defaultChainId?: number;
    /** Paymaster configuration per chain for gasless transactions */
    paymasters?: Record<number, PaymasterConfig>;
    /** App name shown in dialogs */
    appName?: string;
    /** App logo URL */
    appLogoUrl?: string | null;
    /** ENS to issue subnames from */
    ens?: string;
    /** Whether to show testnet chains */
    showTestnets?: boolean;
    /** Theme configuration for UI appearance (colors, mode, border radius) */
    theme?: JawTheme;
}

/**
 * Platform-agnostic UI handler interface
 *
 * Implement this interface to provide custom UI for app-specific mode.
 * The SDK will call the request method when user approval is needed.
 */
export interface UIHandler {
    /**
     * Initialize the handler with SDK configuration
     * Called by the SDK before any requests are made
     * @param config - SDK configuration the handler may need
     */
    init?(config: UIHandlerConfig): void;

    /**
     * Request user approval for an action
     * @param request - The UI request containing action details
     * @returns Promise resolving to user's response
     * @throws {UIError} If user rejects or request times out
     */
    request<T = unknown>(request: UIRequest): Promise<UIResponse<T>>;

    /**
     * Check if this handler can handle a specific request type
     * @param request - The UI request to check
     * @returns true if this handler can handle the request
     */
    canHandle?(request: UIRequest): boolean;

    /**
     * Optional cleanup when handler is no longer needed
     */
    cleanup?(): Promise<void>;
}

/**
 * Options for UI handler
 */
export interface UIHandlerOptions {
    timeout?: number; // milliseconds
}

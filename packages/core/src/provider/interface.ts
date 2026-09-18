import { EventEmitter } from 'eventemitter3';
import { UIHandler } from '../ui/interface.js';
import type { JawTheme } from '../ui/theme.js';

export interface RequestArguments {
    readonly method: string;
    readonly params?: readonly unknown[] | object;
}

export type Address = `0x${string}`;
export interface ProviderRpcError extends Error {
    message: string;
    code: number;
    data?: unknown;
}

export interface ProviderConnectInfo {
    readonly chainId: string;
}

type ProviderEventMap = {
    connect: ProviderConnectInfo;
    disconnect: ProviderRpcError;
    chainChanged: string;
    accountsChanged: string[];
};

export interface ProviderInterface extends EventEmitter<keyof ProviderEventMap> {
    request(args: RequestArguments): Promise<unknown>;
    disconnect(): Promise<void>;
    /** Update the dApp theme after construction; re-themes the live keys dialog in place. */
    setTheme(theme: JawTheme | undefined): void;
    emit<K extends keyof ProviderEventMap>(event: K, ...args: [ProviderEventMap[K]]): boolean;
    on<K extends keyof ProviderEventMap>(event: K, listener: (_: ProviderEventMap[K]) => void): this;
}

export interface AppMetadata {
    /** Application name */
    appName: string;
    /** Application logo image URL; favicon is used if unspecified */
    appLogoUrl: string | null;
    /** Default chain ID to use on first connection (defaults to mainnet if not specified) */
    defaultChainId?: number;
}

export const Mode = {
    CrossPlatform: 'CrossPlatform',
    AppSpecific: 'AppSpecific',
} as const;

export type ModeType = (typeof Mode)[keyof typeof Mode];

export interface JawProviderPreference {
    /**
     * Authentication mode (default: Mode.CrossPlatform)
     * - Mode.CrossPlatform: Cross-platform mode with popup authentication (default)
     * - Mode.AppSpecific: App-specific mode with direct signing
     */
    mode?: ModeType;
    /** Popup URL for cross-platform mode (default: https://keys.jaw.id) */
    keysUrl?: string;
    /** Backend server URL for passkey storage (default: https://api.justaname.id/wallet/v2/passkeys) */
    serverUrl?: string;
    /** Used to issue subnames **/
    ens?: string;
    /** Whether to show testnet chains (default: false) */
    showTestnets?: boolean;
    /** UI handler for app-specific mode (required when mode is Mode.AppSpecific) */
    uiHandler?: UIHandler;
    /** Session cache TTL in seconds. Default: 86400 (24 hours). Set to 0 to disable caching. */
    authTTL?: number;
    /**
     * Transport for CrossPlatform mode (default: 'auto' — embedded iframe
     * primary).
     * - 'auto':   embedded dialog primary with automatic popup fallback where
     *             iframes cannot work (Safari passkey creation, insecure
     *             contexts, unverifiable visibility). The default.
     * - 'iframe': same as 'auto' in this release.
     * - 'popup':  legacy behavior — always window.open to keysUrl. Set this
     *             explicitly to opt out of the embedded dialog.
     * Ignored when mode is Mode.AppSpecific.
     */
    transportMode?: 'popup' | 'iframe' | 'auto';
}

export type ProviderEventCallback = ProviderInterface['emit'];

export class ProviderEventEmitter extends EventEmitter<keyof ProviderEventMap> {}

/**
 * Paymaster configuration for a chain
 */
export type PaymasterConfig = {
    /** The paymaster RPC URL */
    url: string;
    /** Optional context to pass to paymaster calls (e.g., sponsorshipPolicyId for Pimlico) */
    context?: Record<string, unknown>;
};

export interface ConstructorOptions {
    metadata: AppMetadata;
    preference: JawProviderPreference;
    apiKey?: string;
    /** Mapping of chain IDs to paymaster configuration */
    paymasters?: Record<number, PaymasterConfig>;
    /** Theme configuration for UI appearance */
    theme?: JawTheme;
}

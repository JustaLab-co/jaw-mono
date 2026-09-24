import { Address, AppMetadata, JawProviderPreference } from '../provider/interface.js';
import type { WalletConnectResponse } from '../rpc/index.js';
import type { AccountHintData } from '../messages/configMessage.js';

/**
 * Paymaster configuration for a chain
 */
import type { PaymasterConfig } from '../provider/interface.js';
export type { PaymasterConfig };

export type Chain = {
    id: number;
    rpcUrl?: string;
    nativeCurrency?: {
        name?: string;
        symbol?: string;
        decimal?: number;
    };
    /** Optional paymaster configuration for sponsored transactions */
    paymaster?: PaymasterConfig;
};

/**
 * Fee token configuration from wallet capabilities
 */
export type FeeToken = {
    uid: string;
    symbol: string;
    address: string;
    interop: boolean;
    decimals: number;
    feeToken: boolean;
    logoURI?: string;
};

/**
 * Fee token capability from wallet_getCapabilities response
 */
export type FeeTokenCapability = {
    supported: boolean;
    tokens: FeeToken[];
};

export type Account = {
    accounts?: Address[];
    capabilities?: WalletConnectResponse['accounts'][number]['capabilities'];
    chain?: Chain;
    /** Timestamp (in ms) when the account was connected */
    connectedAt?: number;
    /**
     * Last account the user connected with, as reported by the keys app
     * (AccountHint). Persisted here — in the dApp's first-party storage —
     * because the embedded keys iframe's own storage is partitioned and, in
     * Brave/Safari, wiped between visits. Sent back on the handshake so the
     * keys app can show "Continue as" again.
     */
    lastAccount?: AccountHintData;
};

export type Config = {
    metadata?: AppMetadata;
    preference?: JawProviderPreference;
    version: string;
    deviceId?: string;
    apiKey?: string;
    /**
     * The dApp this core instance is acting for. Set only by keys, whose own
     * `Origin` is the same whichever dApp opened it. Never set in a dApp's own
     * page, where the browser already puts the right `Origin` on the request.
     */
    dappOrigin?: string;
    /** Mapping of chain IDs to paymaster configuration */
    paymasters?: Record<number, PaymasterConfig>;
};

export type ChainSlice = {
    chains: Chain[];
};

export type ConfigSlice = {
    config: Config;
};

export type KeysSlice = {
    keys: Record<string, string | null>;
};

export type AccountSlice = {
    account: Account;
};

export type CallStatus = {
    status: 'pending' | 'failed' | 'completed';
    receipts?: unknown[];
    chainId?: number;
    error?: string;
    apiKey?: string;
};

export type CallStatusSlice = {
    callStatuses: Record<string, CallStatus>;
};

export type MergeTypes<T extends unknown[]> = T extends [infer First, ...infer Rest]
    ? First & (Rest extends unknown[] ? MergeTypes<Rest> : Record<string, unknown>)
    : Record<string, unknown>;

export type StoreState = MergeTypes<[ChainSlice, KeysSlice, AccountSlice, ConfigSlice, CallStatusSlice]>;

import { JAW_KEYS_URL, JAW_PASSKEYS_URL } from '../constants.js';
import {
    ProviderInterface,
    AppMetadata,
    JawProviderPreference,
    ConstructorOptions,
    Mode,
    PaymasterConfig,
} from '../provider/interface.js';
import { createJAWProvider } from '../provider/createJAWProvider.js';
import { store, createInitialChains, ChainClients, createClients } from '../store/index.js';
import { announceProvider as announceProviderFn, type AnnounceProviderCleanup } from '../provider/eip6963.js';
import type { JawTheme } from '../ui/theme.js';

export type CreateJAWSDKOptions = Partial<AppMetadata> & {
    /**
     * Identifies the calling dApp to the JAW backend. Optional, because whether
     * a request is served is the backend's decision rather than the SDK's.
     */
    apiKey?: string;
    preference?: Partial<JawProviderPreference>;
    /** Mapping of chain IDs to paymaster configuration */
    paymasters?: Record<number, PaymasterConfig>;
    /** Used to issue subnames */
    ens?: string;
    /** Theme configuration for UI appearance (colors, mode, border radius) */
    theme?: JawTheme;
};

const DEFAULT_PREFERENCE: JawProviderPreference = {
    mode: Mode.CrossPlatform,
    keysUrl: JAW_KEYS_URL,
    serverUrl: JAW_PASSKEYS_URL,
    showTestnets: false,
};
/**
 * Create a JAW SDK instance (factory function pattern).
 *
 * @param params - Configuration options for the SDK.
 * @returns An object with SDK methods and provider access.
 *
 * @example
 * ```typescript
 * import { JAW } from '@jaw.id/core';
 *
 * const jaw = JAW.create({
 *   apiKey: 'your-api-key',
 *   appName: 'My DApp',
 *   appLogoUrl: 'https://example.com/logo.png',
 *   defaultChainId: 1,
 *   preference: {
 *     keysUrl: 'http://localhost:3001',
 *     showTestnets: true
 *   }
 * });
 *
 * await jaw.provider.request({ method: 'eth_requestAccounts' });
 *
 * ```
 */

export function create(params: CreateJAWSDKOptions) {
    const options: ConstructorOptions = {
        apiKey: params.apiKey,
        metadata: {
            appName: params.appName || 'DApp',
            appLogoUrl: params.appLogoUrl || null,
            defaultChainId: params.defaultChainId,
        },
        preference: {
            ...DEFAULT_PREFERENCE,
            ...params.preference,
            ...(params.ens ? { ens: params.ens } : {}),
        },
        paymasters: params.paymasters,
        theme: params.theme,
    };

    if (options.preference?.serverUrl != JAW_PASSKEYS_URL && options.preference.mode == Mode.CrossPlatform) {
        throw new Error('Custom Server Url not available with Cross Platform Mode.');
    }

    // App-specific mode hands the key to the dApp's own UIHandler, which has
    // nowhere to get one. Refused here rather than on the first request, so a
    // misconfigured app fails while it is still being wired up.
    if (options.preference.mode == Mode.AppSpecific && !params.apiKey) {
        throw new Error('API key is required for App Specific Mode.');
    }

    // Store the config
    const storedOptions = {
        metadata: options.metadata,
        preference: options.preference,
        paymasters: options.paymasters,
        apiKey: params.apiKey,
    };
    store.config.set(storedOptions);

    // Always clear and reinitialize chains on SDK creation to ensure consistency
    store.chains.clear();
    ChainClients.setState({});

    const initialChains = createInitialChains(params.apiKey, params.paymasters, options.preference.showTestnets);
    store.chains.set(initialChains);
    createClients(initialChains);

    // Update stored account chain if defaultChainId is provided and differs from stored chain
    if (params.defaultChainId !== undefined) {
        const currentAccount = store.account.get();
        const storedChainId = currentAccount.chain?.id;

        // Only update if the stored chain differs from the requested default
        if (storedChainId !== params.defaultChainId) {
            const targetChain = initialChains.find((c) => c.id === params.defaultChainId);
            if (targetChain) {
                store.account.set({ chain: targetChain });
            }
        }
    }

    let provider: ProviderInterface | null = null;
    let stopAnnouncing: AnnounceProviderCleanup | null = null;

    // Helper to check if EIP-6963 announcement should be enabled
    const isCrossPlatformMode = options.preference?.mode === Mode.CrossPlatform;

    return {
        /**
         * Get the JAW Provider instance.
         * Direct access to the provider for making requests.
         * Creates a new provider if one doesn't exist yet (lazy initialization).
         */
        get provider(): ProviderInterface {
            if (!provider) {
                provider = createJAWProvider(options);

                // Auto-announce via EIP-6963 for CrossPlatform mode
                if (isCrossPlatformMode && typeof window !== 'undefined') {
                    stopAnnouncing = announceProviderFn(provider);
                }
            }
            return provider;
        },

        /**
         * Disconnect the provider and clean up resources.
         * @returns A promise that resolves when disconnection is complete.
         */
        async disconnect(): Promise<void> {
            // Stop announcing when disconnecting
            if (stopAnnouncing) {
                stopAnnouncing();
                stopAnnouncing = null;
            }

            if (provider) {
                await provider.disconnect();
                provider = null;
            }
        },
    };
}

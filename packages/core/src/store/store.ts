import { SDK_VERSION } from '../sdk-info.js';
import { createJSONStorage, persist } from 'zustand/middleware';
import { StateCreator, createStore } from 'zustand/vanilla';
import {
    ChainSlice,
    KeysSlice,
    AccountSlice,
    ConfigSlice,
    CallStatusSlice,
    StoreState,
    Account,
    Chain,
    Config,
    CallStatus,
} from './types.js';

/**
 * Recursively converts BigInt values to strings for JSON serialization
 */
function serializeBigInt(value: unknown): unknown {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (value === null || value === undefined) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(serializeBigInt);
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            result[key] = serializeBigInt(val);
        }
        return result;
    }
    return value;
}

const createChainSlice: StateCreator<StoreState, [], [], ChainSlice> = () => {
    return {
        chains: [],
    };
};
const createKeysSlice: StateCreator<StoreState, [], [], KeysSlice> = () => {
    return {
        keys: {},
    };
};

const createAccountSlice: StateCreator<StoreState, [], [], AccountSlice> = () => {
    return {
        account: {},
    };
};

const createConfigSlice: StateCreator<StoreState, [], [], ConfigSlice> = () => {
    return {
        config: {
            version: SDK_VERSION,
        },
    };
};

const createCallStatusSlice: StateCreator<StoreState, [], [], CallStatusSlice> = () => {
    return {
        callStatuses: {},
    };
};

export const sdkstore = createStore(
    persist<StoreState>(
        (...args) => ({
            ...createChainSlice(...args),
            ...createKeysSlice(...args),
            ...createAccountSlice(...args),
            ...createConfigSlice(...args),
            ...createCallStatusSlice(...args),
        }),
        {
            name: 'jawsdk.store',
            storage: createJSONStorage(() => {
                // Use localStorage only when it's actually usable. A mere
                // `typeof localStorage !== 'undefined'` check is not enough:
                // Node 20+ exposes an experimental `localStorage` global whose
                // methods throw / are missing without `--localstorage-file`,
                // which broke persistence in tests and SSR prerender. Probe it.
                try {
                    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
                        const probeKey = '__jawsdk_storage_probe__';
                        localStorage.setItem(probeKey, '1');
                        localStorage.removeItem(probeKey);
                        return localStorage;
                    }
                } catch {
                    /* unusable storage — fall through to the no-op below */
                }
                // No-op storage for non-browser / unusable environments.
                return {
                    getItem: () => null,
                    setItem() {
                        /* noop */
                    },
                    removeItem() {
                        /* noop */
                    },
                };
            }),
            partialize: (state) => {
                // Explicitly select only the data properties we want to persist
                // (not the methods)
                // Serialize callStatuses receipts to handle BigInt values
                const serializedCallStatuses = Object.entries(state.callStatuses).reduce(
                    (acc, [key, status]) => {
                        acc[key] = {
                            ...status,
                            receipts: status.receipts
                                ? (serializeBigInt(status.receipts) as unknown[])
                                : status.receipts,
                        };
                        return acc;
                    },
                    {} as Record<string, CallStatus>
                );

                // dappOrigin is per-flow, not per-install: keys.jaw.id is one origin
                // shared by every dApp in popup mode, so a persisted value would greet
                // the next dApp holding the previous one's origin.
                const config = { ...state.config };
                delete config.dappOrigin;

                return {
                    chains: state.chains,
                    keys: state.keys,
                    account: state.account,
                    config,
                    callStatuses: serializedCallStatuses,
                } as StoreState;
            },
        }
    )
);

export const account = {
    get: () => sdkstore.getState().account,
    set: (account: Partial<Account>) => {
        sdkstore.setState((state) => ({
            account: {
                ...state.account,
                ...account,
                // Set connectedAt when accounts are provided (new connection)
                ...(account.accounts && { connectedAt: Date.now() }),
            },
        }));
    },
    clear: () => {
        sdkstore.setState((state) => ({
            // Keep lastAccount: clear() fires on disconnect and session-TTL
            // expiry, and the "Continue as" hint must survive both so the
            // next connect can still offer the previous account. It is a UX
            // pointer, not authorization — reconnecting always re-runs the
            // passkey ceremony.
            account: state.account.lastAccount ? { lastAccount: state.account.lastAccount } : {},
        }));
    },
};

export const chains = {
    get: () => sdkstore.getState().chains,
    set: (chains: Chain[]) => {
        sdkstore.setState({ chains });
    },
    clear: () => {
        sdkstore.setState({
            chains: [],
        });
    },
};

export const keys = {
    get: (key: string) => sdkstore.getState().keys[key],
    set: (key: string, value: string | null) => {
        sdkstore.setState((state) => ({ keys: { ...state.keys, [key]: value } }));
    },
    clear: () => {
        sdkstore.setState({
            keys: {},
        });
    },
};

export const config = {
    get: () => sdkstore.getState().config,
    set: (config: Partial<Config>) => {
        sdkstore.setState((state) => ({ config: { ...state.config, ...config } }));
    },
};

export const callStatuses = {
    get: (batchId: string) => sdkstore.getState().callStatuses[batchId],
    set: (batchId: string, status: CallStatus) => {
        // Serialize receipts to handle BigInt values before storing
        const serializedStatus: CallStatus = {
            ...status,
            receipts: status.receipts ? (serializeBigInt(status.receipts) as unknown[]) : status.receipts,
        };
        sdkstore.setState((state) => ({
            callStatuses: { ...state.callStatuses, [batchId]: serializedStatus },
        }));
    },
    update: (batchId: string, updates: Partial<CallStatus>) => {
        const current = sdkstore.getState().callStatuses[batchId];
        if (current) {
            // Serialize receipts if they're being updated
            const serializedUpdates: Partial<CallStatus> = {
                ...updates,
                receipts: updates.receipts ? (serializeBigInt(updates.receipts) as unknown[]) : updates.receipts,
            };
            sdkstore.setState((state) => ({
                callStatuses: { ...state.callStatuses, [batchId]: { ...current, ...serializedUpdates } },
            }));
        }
    },
    clear: () => {
        sdkstore.setState({
            callStatuses: {},
        });
    },
};

const actions = {
    account,
    chains,
    keys,
    config,
    callStatuses,
};

export const store = {
    ...sdkstore,
    ...actions,
};

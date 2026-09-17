/**  Constants **/
export {
    JAW_BASE_URL,
    JAW_RPC_URL,
    JAW_PAYMASTER_URL,
    JAW_WALLET_ICON,
    JAW_WALLET_NAME,
    JAW_WALLET_ID,
    JAW_WALLET_RDNS,
    PERMISSIONS_MANAGER_ADDRESS,
} from './constants.js';

/**  SDK Info **/
export { SDK_VERSION, SDK_NAME } from './sdk-info.js';

/** SDK exports **/
export { create, JAW, type CreateJAWSDKOptions } from './sdk/index.js';

/** Transport layer (keys communication) **/
export { Communicator, type CommunicatorOptions } from './communicator/index.js';

/**  RPC types and utilities **/
export {
    // Capability types
    type SignInWithEthereumCapabilityRequest,
    type SignInWithEthereumCapabilityResponse,
    type SubnameTextRecordCapabilityRequest,
    type SubnameTextRecordCapabilityResponse,
    // Wallet connect types
    type WalletConnectCapabilities,
    type WalletConnectRequest,
    type WalletConnectResponse,
    // Viem RPC types
    type ViemRPCParams,
    type ViemRPCReturnType,
    // Permission types (used with Account.grantPermissions/revokePermission)
    type Permission,
    type SpendPeriod,
    type SpendPermissionDetail,
    type CallPermissionDetail,
    type PermissionsDetail,
    type PaymasterServiceCapability,
    type RequestCapabilities,
    type WalletGrantPermissionsRequest,
    type WalletGrantPermissionsResponse,
    type WalletGetPermissionsResponse,
    type WalletRevokePermissionsRequest,
    type RevokePermissionApiResponse,
    // Permission utilities for UI (fetching permission details without Account instance)
    type StorePermissionApiResponse,
    getPermissionFromRelay,
    // Permission call builders (for gas estimation)
    buildGrantPermissionCall,
    buildRevokePermissionCall,
    // RPC handlers
    handleGetAssetsRequest,
    handleGetCallsHistoryRequest,
    handleGetPermissionsRequest,
    handleGetCapabilitiesRequest,
    clearCapabilitiesCache,
    type CapabilitiesResult,
    type ChainMetadataCapability,
    // Permission selector constants
    ANY_TARGET,
    ANY_FN_SEL,
    EMPTY_CALLDATA_FN_SEL,
    // Asset types (EIP-7811 wallet_getAssets)
    type AssetType,
    type AssetMetadata,
    type Asset,
    type AssetFilterEntry,
    type AssetFilter,
    type WalletGetAssetsParams,
    type WalletGetAssetsResponse,
    // Calls history types
    type WalletGetCallsHistoryParams,
    type WalletGetCallsHistoryResponse,
} from './rpc/index.js';

/** Calls history types (from API routes) **/
export type { CallsHistoryItem } from './api/routes/index.js';

/**  Account exports **/
export * from './account/index.js';

/**  Error exports **/
export * from './errors/index.js';

/** Provider exports **/
export {
    type RequestArguments,
    type ProviderRpcError,
    type ProviderConnectInfo,
    type ProviderInterface,
    type AppMetadata,
    type JawProviderPreference,
    type ModeType,
    type ProviderEventCallback,
    Mode,
    JAWProvider,
    createJAWProvider,
    type CreateProviderOptions,
} from './provider/index.js';

/** Passkey exports (used with Account class) **/
export {
    PasskeyManager,
    lookupPasskeyFromBackend,
    type PasskeyLookupResponse,
    type PasskeyAccount,
    type NativePasskeyGetFn,
    type NativePasskeyCreateFn,
    type NativeCredentialResult,
} from './passkey-manager/index.js';

/** Storage exports (used with AccountConfig.storage for React Native) **/
export { type SyncStorage, createMemoryStorage } from './storage-manager/index.js';

/** Key Manager exports **/
export { KeyManager } from './key-manager/index.js';

/** Messages exports **/
export * from './messages/index.js';

/** Utils exports **/
export * from './utils/index.js';

/** Store exports **/
export { type Chain, type FeeToken, type FeeTokenCapability } from './store/index.js';

/** Analytics exports **/
export {
    logAccountIssuance,
    logSignature,
    type LogAccountIssuanceParams,
    type LogSignatureParams,
    type IssuanceType,
} from './analytics/index.js';

/** UI Handler exports (for app-specific mode) **/
export type {
    UIHandler,
    UIHandlerConfig,
    UIRequest,
    UIResponse,
    UIRequestType,
    ConnectUIRequest,
    SignatureUIRequest,
    TypedDataUIRequest,
    TransactionUIRequest,
    PermissionUIRequest,
    RevokePermissionUIRequest,
    SendTransactionUIRequest,
    WalletSignUIRequest,
    UIHandlerOptions,
    BaseUIRequest,
    PermissionsCapability,
    PaymasterConfig,
    PersonalSignRequestData,
    TypedDataRequestData,
} from './ui/interface.js';

export { UIError, UIErrorCode } from './ui/interface.js';

/** Theme types **/
export type { JawTheme, JawThemeColors, JawThemeMode, JawBorderRadius, JawFontStack } from './ui/theme.js';

/** Method policy (silent vs interactive RPC classification) **/
export { SILENT_METHODS, INTERACTIVE_METHODS, isSilentMethod, requiresInteraction } from './method-policy.js';

/**
 * Symbols the published surface already reached but could not name.
 *
 * `standardErrors` is exported below and every one of its members returns an
 * `EthereumRpcError` built from an `EthErrorsArg` or a `ServerErrorOptions`, so
 * a consumer typing a catch or a wrapper was already holding these. They had no
 * importable name, and api-extractor recorded each one as a warning carrying
 * `src/errors/errors.ts:<line>`. Those coordinates put the committed report at
 * the mercy of edits that change no API at all: a doc comment above the
 * declaration shifts the line and reddens `api-check`, which trains everyone to
 * regenerate the report without reading it.
 *
 * Exporting them removes the coordinates and makes the commitment explicit
 * rather than accidental. The two classes ship runtime, so `instanceof` on them
 * is now something we support.
 */
export {
    type EthereumErrorOptions,
    type EthErrorsArg,
    type ServerErrorOptions,
    type CustomErrorArg,
    EthereumRpcError,
    EthereumProviderError,
} from './errors/errors.js';
export type { CallPermission, SpendLimit } from './rpc/permissions.js';
export type { SendCallsVersion } from './rpc/sendCallsParams.js';
export type { Address } from './provider/interface.js';

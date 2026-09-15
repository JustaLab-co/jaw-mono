// Connector
export {
  jaw,
  type JawParameters,
  type WalletConnectCapabilities,
  type AccountWithCapabilities,
} from './lib/Connector.js';

// Re-export types from core that are used in hook parameters
export type {
  PersonalSignRequestData,
  TypedDataRequestData,
  PermissionsDetail,
  CallPermissionDetail,
  SpendPermissionDetail,
} from '@jaw.id/core';

// Actions namespace
export * as Actions from './lib/Actions.js';

// Hooks namespace
export * as Hooks from './lib/Hooks.js';

// Query namespace
export * as Query from './lib/Query.js';

// Also export individual hooks for convenience
export {
  useConnect,
  useDisconnect,
  useGrantPermissions,
  useRevokePermissions,
  usePermissions,
  useGetAssets,
  useCapabilities,
  useSign,
  useGetCallsHistory,
  useAddFunds,
} from './lib/Hooks.js';

// Also export individual actions for convenience
export {
  connect,
  disconnect,
  grantPermissions,
  getPermissions,
  revokePermissions,
  getAssets,
  getCapabilities,
  sign,
  getCallsHistory,
  addFunds,
} from './lib/Actions.js';

// Also export query keys for convenience
export {
  getPermissionsQueryKey,
  getAssetsQueryKey,
  getCapabilitiesQueryKey,
  getCallsHistoryQueryKey,
} from './lib/Query.js';

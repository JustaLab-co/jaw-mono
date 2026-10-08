import { PasskeyRoutes, PASSKEY_ROUTE, ACCOUNT_ROUTE } from './passkey.js';
import { PermissionsRoutes, PERMISSIONS_ROUTE } from './permissions.js';
import { AnalyticsRoutes, ANALYTICS_ROUTE } from './analytics.js';
import { CallsHistoryRoutes, CALLS_HISTORY_ROUTE } from './callsHistory.js';

/**
 * All API routes combined
 */
export type ROUTES = PasskeyRoutes & PermissionsRoutes & AnalyticsRoutes & CallsHistoryRoutes;

/**
 * Route paths mapped to their keys
 * Routes with dynamic segments use colon-prefixed parameters (e.g., :hash)
 */
export const Routes: Record<keyof ROUTES, string> = {
    REGISTER_PASSKEY: PASSKEY_ROUTE,
    LOOKUP_PASSKEYS: PASSKEY_ROUTE,
    GET_ACCOUNT_BY_CREDENTIAL: ACCOUNT_ROUTE,
    STORE_PERMISSION: PERMISSIONS_ROUTE,
    GET_PERMISSION: `${PERMISSIONS_ROUTE}/:hash`,
    DELETE_PERMISSION: `${PERMISSIONS_ROUTE}/:hash`,
    LOG_ACCOUNT_ISSUANCE: ANALYTICS_ROUTE,
    LOG_SIGNATURE: `${ANALYTICS_ROUTE}/signature`,
    UPDATE_CALL_STATUS: `${CALLS_HISTORY_ROUTE}/:id`,
    GET_CALLS_HISTORY: CALLS_HISTORY_ROUTE,
};

export { PASSKEY_ROUTE } from './passkey.js';
export type { PasskeyRoutes } from './passkey.js';
export { PERMISSIONS_ROUTE } from './permissions.js';
export type { PermissionsRoutes } from './permissions.js';
export { ANALYTICS_ROUTE } from './analytics.js';
export type { AnalyticsRoutes, LogAccountIssuanceRequest, LogSignatureRequest, IssuanceType } from './analytics.js';
export { CALLS_HISTORY_ROUTE } from './callsHistory.js';
export type {
    CallsHistoryRoutes,
    UpdateCallStatusRequest,
    GetCallsHistoryRequest,
    CallsHistoryItem,
} from './callsHistory.js';

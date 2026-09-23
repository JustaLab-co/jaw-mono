import type {
    StorePermissionApiRequest,
    StorePermissionApiResponse,
    RevokePermissionApiResponse,
} from '../../rpc/permissions.js';

/**
 * Permissions API routes
 */
export const PERMISSIONS_ROUTE = '/permissions';

/**
 * Route definitions for permissions operations
 */
export interface PermissionsRoutes {
    // The key is optional on all three: a dApp registered by origin has none, and
    // reads and writes alike are reached both from its own page and from the keys
    // origin. What identifies the caller when it is missing is `x-dapp-origin`,
    // which restCall attaches.
    STORE_PERMISSION: {
        request: StorePermissionApiRequest;
        response: StorePermissionApiResponse;
        headers: { 'x-api-key'?: string };
        pathParams?: never;
    };
    GET_PERMISSION: {
        request: Record<string, never>;
        response: StorePermissionApiResponse;
        headers: { 'x-api-key'?: string };
        pathParams: { hash: string };
    };
    DELETE_PERMISSION: {
        request: Record<string, never>;
        response: RevokePermissionApiResponse;
        headers: { 'x-api-key'?: string };
        pathParams: { hash: string };
    };
}

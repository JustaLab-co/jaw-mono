import type { Address } from 'viem';
import type {
    AdminBatch,
    ApproveCeremonyRequest,
    Ceremony,
    CeremonyApproval,
    CeremonyListResponse,
    CreateCeremonyRequest,
    CreatedCeremony,
    RecoveryConfigResponse,
    SubmitAdminBatchRequest,
} from '../../rpc/recovery.js';

/**
 * Recovery API routes, served by the recovery app behind the gateway.
 */
export const RECOVERY_ROUTE = '/recovery/v2';

/**
 * Query for the ceremony list. Values travel as strings; the backend reads
 * `executed` as a boolean.
 */
export interface ListCeremoniesRequest {
    /** The smart account whose ceremonies are listed */
    account: Address;
    /** 'true' keeps the ceremonies executed on at least one chain, 'false' the others; absent keeps all */
    executed?: 'true' | 'false';
}

/**
 * Route definitions for recovery operations. The shapes mirror the backend's
 * DTOs one to one; this file is the contract between the two repos.
 */
export interface RecoveryRoutes {
    GET_RECOVERY_CONFIG: {
        request: Record<string, never>;
        response: RecoveryConfigResponse;
        headers: { 'x-api-key'?: string };
        pathParams: { account: string };
    };
    SUBMIT_ADMIN_BATCH: {
        request: SubmitAdminBatchRequest;
        response: AdminBatch;
        headers: { 'x-api-key'?: string };
        pathParams?: never;
    };
    GET_ADMIN_BATCH: {
        request: Record<string, never>;
        response: AdminBatch;
        headers: { 'x-api-key'?: string };
        pathParams: { id: string };
    };
    CREATE_CEREMONY: {
        request: CreateCeremonyRequest;
        response: CreatedCeremony;
        headers: { 'x-api-key'?: string };
        pathParams?: never;
    };
    APPROVE_CEREMONY: {
        request: ApproveCeremonyRequest;
        response: CeremonyApproval;
        headers: { 'x-api-key'?: string };
        pathParams: { requestId: string };
    };
    GET_CEREMONY: {
        request: Record<string, never>;
        response: Ceremony;
        headers: { 'x-api-key'?: string };
        pathParams: { requestId: string };
    };
    LIST_CEREMONIES: {
        request: ListCeremoniesRequest;
        response: CeremonyListResponse;
        headers: { 'x-api-key'?: string };
        pathParams?: never;
    };
}

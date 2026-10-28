import {
    encodeAbiParameters,
    encodeFunctionData,
    isHex,
    keccak256,
    pad,
    size,
    toHex,
    type Address,
    type Hex,
    type TypedDataDefinition,
} from 'viem';
import { RECOVERY_MANAGER_ADDRESS, SIGNATURE_RECOVERY_PROVIDER_ADDRESS } from '../constants.js';
import { abi as justanAccountAbi } from '../account/toJustanAccount.js';
import { restCall } from '../api/index.js';
import { standardErrors } from '../errors/errors.js';
import type { RequestArguments } from '../provider/index.js';
import type { RequestCapabilities } from './permissions.js';
import { isHexString, isRecord, optionalHexAddress, requireHexBytes32, requireParamsObject } from './paramUtils.js';

/**
 * How long a signed admin batch stays submittable, in seconds. The backend
 * refuses an expiry further than 15 minutes ahead.
 */
export const DEFAULT_RECOVERY_ADMIN_EXPIRY_SECONDS = 600;

/**
 * `IRecoveryManager.AdminOpType`, in the Solidity enum order
 */
export const AdminOpType = {
    ADD_RECOVERY: 0,
    REMOVE_RECOVERY: 1,
    SET_THRESHOLD: 2,
    CANCEL_REQUEST: 3,
} as const;
export type AdminOpType = (typeof AdminOpType)[keyof typeof AdminOpType];

/**
 * One admin operation inside a signed `RecoveryAdmin` batch
 */
export type AdminOp = {
    /** The op type (see AdminOpType) */
    opType: AdminOpType;
    /** The op payload, abi-encoded as the manager decodes it */
    data: Hex;
};

/**
 * A recovery method registered for an account, as the manager holds it
 */
export type RecoveryMethod = {
    /** keccak256(abi.encode(account, provider, commitment)) */
    recoveryId: Hex;
    /** The recovery provider contract that verifies this method's proofs */
    provider: Address;
    /** What the provider verifies against: a 32-byte padded address or a 64-byte passkey public key */
    commitment: Hex;
    /** Seconds between a recovery request and its execution */
    delay: number;
};

/**
 * The account's recovery state on one chain, read from the chain by the backend
 */
export type RecoveryChainConfig = {
    chainId: number;
    /** Whether the account has code on this chain */
    deployed: boolean;
    /** Whether the recovery manager is an owner of the account */
    enrolled: boolean;
    /** The stored recovery threshold, zero when never set */
    threshold: number;
    /** The methods the manager holds for the account */
    recoveries: RecoveryMethod[];
};

/**
 * Response from the configs read: one entry per recovery-supported chain
 */
export type RecoveryConfigResponse = {
    chains: RecoveryChainConfig[];
};

/**
 * A recovery method to register
 */
export type RecoveryMethodInput = {
    /** A 32-byte padded address or a 64-byte passkey public key (see toOwnerBytes) */
    commitment: Hex;
    /** Seconds between a recovery request and its execution */
    delay: number;
    /** The provider that verifies this method; defaults to SignatureRecoveryProvider */
    provider?: Address;
};

/**
 * The desired recovery configuration: the end state, not the edits
 */
export type RecoveryConfig = {
    recoveries: RecoveryMethodInput[];
    /** Approvals a recovery needs, between 1 and the number of methods */
    threshold: number;
};

/**
 * Status of a relayer job on one chain
 */
export type AdminBatchStatus = 'PENDING' | 'CLAIMED' | 'SUBMITTED' | 'COMPLETED' | 'SKIPPED' | 'EXPIRED' | 'DEAD';

export type AdminBatchChain = {
    chainId: number;
    status: AdminBatchStatus;
    /** The transaction hash once the job landed, else null */
    txHash: Hex | null;
};

/**
 * A submitted admin batch and the status of its job on every chain it was queued on
 */
export type AdminBatch = {
    /** keccak256(abi.encodePacked(account, salt)) */
    id: Hex;
    /** The signed expiry, ISO 8601 */
    expiry: string;
    chains: AdminBatchChain[];
};

/**
 * Request to submit a signed admin batch
 */
export type SubmitAdminBatchRequest = {
    account: Address;
    /** The signed ops, in signing order */
    ops: AdminOp[];
    /** The signed salt; with the account it identifies the batch */
    salt: Hex;
    /** The signed expiry, unix seconds */
    expiry: number;
    /** The signing owner: 32 bytes (padded address) or 64 bytes (passkey x, y) */
    ownerBytes: Hex;
    /** The owner signature over the batch, as the account verifies it */
    proof: Hex;
    /** The chains the batch is executed on */
    chainIds: number[];
};

/**
 * Status of a ceremony on one chain
 */
export type CeremonyChainStatus =
    | 'COLLECTING'
    | 'PENDING'
    | 'REQUESTED'
    | 'EXECUTED'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'FAILED'
    | 'SKIPPED';

export type CeremonyGuardian = RecoveryMethod & {
    /** When this guardian's approval verified, ISO 8601; null when it has not approved */
    approvedAt: string | null;
};

export type CeremonyChain = {
    chainId: number;
    status: CeremonyChainStatus;
    /** When the execution is due, ISO 8601, once the request landed; else null */
    executeAt: string | null;
    requestTxHash: Hex | null;
    executeTxHash: Hex | null;
};

/**
 * A recovery ceremony: the signed tuple, the guardians and the state per chain
 */
export type Ceremony = {
    /** keccak256(abi.encode(account, subject, salt)): the request id on every chain */
    requestId: Hex;
    account: Address;
    /** The new owner the guardians approve: 32 bytes (padded address) or 64 bytes (passkey x, y) */
    subject: Hex;
    salt: Hex;
    /** The expiry every guardian signs over, ISO 8601 */
    expiry: string;
    /** Approvals the request needs */
    threshold: number;
    /** Verified approvals so far */
    collected: number;
    guardians: CeremonyGuardian[];
    chains: CeremonyChain[];
};

/**
 * One entry of the ceremony list: the ceremony without its salt and guardians
 */
export type CeremonyListEntry = Pick<Ceremony, 'requestId' | 'account' | 'subject' | 'expiry' | 'chains'>;

export type CeremonyListResponse = {
    /** The account's newest ceremonies first, at most 50 */
    ceremonies: CeremonyListEntry[];
};

export type CreateCeremonyRequest = {
    account: Address;
    /** The new owner: 32 bytes (padded address) or 64 bytes (passkey x, y) */
    subject: Hex;
    /** A fresh salt; with the account and subject it identifies the request */
    salt: Hex;
};

/**
 * The ceremony as created: the tuple every guardian signs over
 */
export type CreatedCeremony = Pick<Ceremony, 'requestId' | 'account' | 'subject' | 'salt' | 'expiry'>;

export type ApproveCeremonyRequest = {
    /** The approving guardian, as the recovery manager registered it */
    recoveryId: Hex;
    /** The guardian's proof over the request, as its provider verifies it */
    proof: Hex;
};

export type CeremonyApproval = {
    collected: number;
    threshold: number;
    /** True when this approval queued the request on every chain */
    queued: boolean;
};

/**
 * The outcome of Account.setupRecovery and Account.cancelRecovery
 */
export type RecoverySetupResult = {
    /**
     * 'account': one userOp on the connected chain, landed before this returns.
     * 'relay': one owner signature the backend fans out; poll `getAdminBatch`
     * with `batchId` until no chain is in flight.
     */
    door: 'account' | 'relay';
    /** The relayed batch; absent for the account door */
    batchId?: Hex;
    /** One entry per chain the operation targets */
    chains: AdminBatchChain[];
};

/**
 * What Account.getRecovery returns
 */
export type RecoveryState = {
    /** The recovery config on every recovery-supported chain */
    chains: RecoveryChainConfig[];
    /** The account's ceremonies not executed on any chain, newest first */
    pending: CeremonyListEntry[];
};

/**
 * Request parameters for wallet_setupRecovery
 *
 * The desired end state, as for wallet_grantPermissions: the dApp passes every
 * method and the threshold, the wallet shows the account's current config and
 * the changes, and the user approves or declines. The config is account-level,
 * so there is no chainId: a first setup lands on the connected chain and an
 * edit reaches every enrolled chain.
 */
export type WalletSetupRecoveryRequest = {
    method: 'wallet_setupRecovery';
    params: [
        {
            /** Every method the config should hold; a method left out is removed */
            recoveries: RecoveryMethodInput[];
            /** Approvals a recovery needs, between 1 and the number of methods */
            threshold: number;
            /** Optional capabilities including paymaster service for the account-door userOp */
            capabilities?: RequestCapabilities;
        },
    ];
};

/**
 * Request parameters for wallet_cancelRecovery: the veto
 */
export type WalletCancelRecoveryRequest = {
    method: 'wallet_cancelRecovery';
    params: [
        {
            /** The ceremony's request id, the same on every chain */
            requestId: Hex;
            /** Optional capabilities including paymaster service for the account-door userOp */
            capabilities?: RequestCapabilities;
        },
    ];
};

/**
 * Request parameters for wallet_getRecovery
 */
export type WalletGetRecoveryRequest = {
    method: 'wallet_getRecovery';
    params?: [
        {
            /** The account to read; the connected account when omitted */
            address?: Address;
        },
    ];
};

/** A wallet_setupRecovery request after validation: the end state is guaranteed present. */
export interface NormalizedSetupRecoveryParams {
    /** The methods, commitments in their canonical form (see toOwnerBytes) */
    recoveries: RecoveryMethodInput[];
    /** Approvals a recovery needs, between 1 and the number of methods */
    threshold: number;
    capabilities?: RequestCapabilities;
}

/** A wallet_cancelRecovery request after validation: the request id is guaranteed present. */
export interface NormalizedCancelRecoveryParams {
    requestId: Hex;
    capabilities?: RequestCapabilities;
}

/**
 * The canonical MultiOwnable owner bytes: a 20-byte address padded to 32 bytes,
 * or a 64-byte passkey public key as it is. Commitments, subjects and
 * `ownerBytes` all take this form.
 */
export function toOwnerBytes(owner: Address | Hex): Hex {
    const length = isHex(owner) ? size(owner) : 0;
    if (length === 20) return pad(owner, { size: 32 });
    if (length === 64) return owner;
    throw standardErrors.rpc.invalidParams({
        message: `Expected a 20-byte address or a 64-byte public key, got ${length} bytes`,
    });
}

/**
 * The id the manager keys a registered recovery by
 */
export function computeRecoveryId(account: Address, provider: Address, commitment: Hex): Hex {
    return keccak256(
        encodeAbiParameters(
            [{ type: 'address' }, { type: 'address' }, { type: 'bytes' }],
            [account, provider, commitment]
        )
    );
}

/**
 * The id a ceremony's request has on every chain
 */
export function computeRequestId(account: Address, subject: Hex, salt: Hex): Hex {
    return keccak256(
        encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }, { type: 'bytes32' }], [account, subject, salt])
    );
}

/**
 * A fresh single-use salt for an admin batch or a ceremony
 */
export function randomSalt(): Hex {
    return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * EIP-712 types of the admin door, `JustaRecoveryManager.RECOVERY_ADMIN_TYPEHASH`
 */
export const RECOVERY_ADMIN_TYPES = {
    RecoveryAdmin: [
        { name: 'account', type: 'address' },
        { name: 'ops', type: 'AdminOp[]' },
        { name: 'salt', type: 'bytes32' },
        { name: 'expiry', type: 'uint256' },
    ],
    AdminOp: [
        { name: 'opType', type: 'uint8' },
        { name: 'data', type: 'bytes' },
    ],
} as const;

/**
 * EIP-712 types of a guardian's approval, `SignatureRecoveryProvider.RECOVER_TYPEHASH`
 */
export const RECOVER_TYPES = {
    Recover: [
        { name: 'account', type: 'address' },
        { name: 'subject', type: 'bytes' },
        { name: 'salt', type: 'bytes32' },
        { name: 'expiry', type: 'uint256' },
    ],
} as const;

export type RecoveryAdminMessage = {
    account: Address;
    ops: AdminOp[];
    salt: Hex;
    /** Unix seconds */
    expiry: number;
};

export type RecoverMessage = {
    account: Address;
    subject: Hex;
    salt: Hex;
    /** Unix seconds, or the ISO 8601 string the backend returns */
    expiry: number | string;
};

function expirySeconds(expiry: number | string): bigint {
    return BigInt(typeof expiry === 'number' ? expiry : Math.floor(Date.parse(expiry) / 1000));
}

/**
 * The typed data an owner signs to authorize an admin batch. The domain omits
 * chainId and the manager has one address on every chain, so the digest is the
 * same everywhere and the relayer can land one signature on each.
 */
export function recoveryAdminTypedData(
    message: RecoveryAdminMessage
): TypedDataDefinition<typeof RECOVERY_ADMIN_TYPES, 'RecoveryAdmin'> {
    return {
        domain: { name: 'JustaRecoveryManager', version: '1', verifyingContract: RECOVERY_MANAGER_ADDRESS },
        types: RECOVERY_ADMIN_TYPES,
        primaryType: 'RecoveryAdmin',
        message: { ...message, expiry: BigInt(message.expiry) },
    };
}

/**
 * The typed data a guardian signs to approve a ceremony, under the signature
 * provider's domain. Chain-free for the same reason as the admin batch.
 */
export function recoverTypedData(message: RecoverMessage): TypedDataDefinition<typeof RECOVER_TYPES, 'Recover'> {
    return {
        domain: {
            name: 'SignatureRecoveryProvider',
            version: '1',
            verifyingContract: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
        },
        types: RECOVER_TYPES,
        primaryType: 'Recover',
        message: { ...message, expiry: expirySeconds(message.expiry) },
    };
}

export function addRecoveryOp(method: RecoveryMethodInput): AdminOp {
    return {
        opType: AdminOpType.ADD_RECOVERY,
        data: encodeAbiParameters(
            [{ type: 'address' }, { type: 'bytes' }, { type: 'uint32' }],
            [method.provider ?? SIGNATURE_RECOVERY_PROVIDER_ADDRESS, method.commitment, method.delay]
        ),
    };
}

export function removeRecoveryOp(recoveryId: Hex): AdminOp {
    return { opType: AdminOpType.REMOVE_RECOVERY, data: encodeAbiParameters([{ type: 'bytes32' }], [recoveryId]) };
}

export function setThresholdOp(threshold: number): AdminOp {
    return { opType: AdminOpType.SET_THRESHOLD, data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(threshold)]) };
}

/**
 * The veto. A cancel travels alone: the backend refuses a batch that mixes it with other ops.
 */
export function cancelRequestOp(requestId: Hex): AdminOp {
    return { opType: AdminOpType.CANCEL_REQUEST, data: encodeAbiParameters([{ type: 'bytes32' }], [requestId]) };
}

function methodKey(provider: Address, commitment: Hex): string {
    return `${provider.toLowerCase()}:${commitment.toLowerCase()}`;
}

function withProvider(method: RecoveryMethodInput): Required<RecoveryMethodInput> {
    return { ...method, provider: method.provider ?? SIGNATURE_RECOVERY_PROVIDER_ADDRESS };
}

function assertThreshold(config: RecoveryConfig): void {
    if (config.threshold < 1 || config.threshold > config.recoveries.length) {
        throw standardErrors.rpc.invalidParams({
            message: `Recovery threshold must be between 1 and ${config.recoveries.length}, got ${config.threshold}`,
        });
    }
}

/**
 * One step from the on-chain config to the desired one, as a confirm screen
 * lists it: each becomes one admin op or one account-door call.
 */
export type RecoveryChange =
    | { kind: 'add'; method: Required<RecoveryMethodInput> }
    | { kind: 'remove'; recoveryId: Hex }
    | { kind: 'threshold'; threshold: number };

/**
 * The minimal ordered change list from the on-chain config to the desired one.
 *
 * Adds come first, then a delay change as a remove plus an add of the same
 * commitment (the manager has no edit), then the threshold, then removals. The
 * threshold drops to 1 for the swap so the removal never falls below it, and is
 * set before the removals for the same reason. Both doors apply the list
 * atomically, so no intermediate state ever exists on chain.
 */
export function planRecoveryChanges(current: RecoveryChainConfig, desired: RecoveryConfig): RecoveryChange[] {
    assertThreshold(desired);

    const registered = new Map(
        current.recoveries.map((method) => [methodKey(method.provider, method.commitment), method])
    );
    const wanted = desired.recoveries.map(withProvider);
    const wantedKeys = new Set(wanted.map((method) => methodKey(method.provider, method.commitment)));

    const changes: RecoveryChange[] = [];

    for (const method of wanted) {
        if (!registered.has(methodKey(method.provider, method.commitment))) changes.push({ kind: 'add', method });
    }

    const redelayed = wanted.filter((method) => {
        const existing = registered.get(methodKey(method.provider, method.commitment));
        return existing !== undefined && existing.delay !== method.delay;
    });
    if (redelayed.length > 0) {
        changes.push({ kind: 'threshold', threshold: 1 });
        for (const method of redelayed) {
            const existing = registered.get(methodKey(method.provider, method.commitment));
            if (existing) changes.push({ kind: 'remove', recoveryId: existing.recoveryId }, { kind: 'add', method });
        }
    }

    if (redelayed.length > 0 || current.threshold !== desired.threshold) {
        changes.push({ kind: 'threshold', threshold: desired.threshold });
    }

    for (const [key, method] of registered) {
        if (!wantedKeys.has(key)) changes.push({ kind: 'remove', recoveryId: method.recoveryId });
    }

    return changes;
}

function changeToOp(change: RecoveryChange): AdminOp {
    switch (change.kind) {
        case 'add':
            return addRecoveryOp(change.method);
        case 'remove':
            return removeRecoveryOp(change.recoveryId);
        case 'threshold':
            return setThresholdOp(change.threshold);
    }
}

function changeToCall(account: Address, change: RecoveryChange): { to: Address; data: Hex } {
    switch (change.kind) {
        case 'add':
            return buildAddRecoveryCall(account, change.method);
        case 'remove':
            return buildRemoveRecoveryCall(account, change.recoveryId);
        case 'threshold':
            return buildSetRecoveryThresholdCall(account, change.threshold);
    }
}

/**
 * The admin-door batch that takes the on-chain config to the desired one, as
 * the owner signs it: one signature, relayed to every enrolled chain.
 */
export function diffRecoveryConfig(current: RecoveryChainConfig, desired: RecoveryConfig): AdminOp[] {
    return planRecoveryChanges(current, desired).map(changeToOp);
}

/**
 * Whether a setup on this chain is the first one: the manager is not an owner
 * yet, or holds no method for the account. A first setup goes through the
 * account door; anything else is an edit the admin door relays.
 */
export function isFirstRecoverySetup(current: RecoveryChainConfig): boolean {
    return !current.enrolled || current.recoveries.length === 0;
}

/**
 * The shortest wait any group of methods able to meet the threshold could get:
 * the threshold-th smallest delay. A request waits for the longest delay among
 * the methods that approved it, so this is the owner's guaranteed time to
 * cancel. Null while the list cannot meet the threshold.
 */
export function minimumRecoveryDelay(recoveries: RecoveryMethodInput[], threshold: number): number | null {
    if (threshold < 1 || threshold > recoveries.length) return null;
    return recoveries.map((method) => method.delay).sort((a, b) => a - b)[threshold - 1];
}

/**
 * Opt in: the account registers the recovery manager as one of its owners. A
 * self-call, so it rides in the same userOp as the config that follows it.
 */
export function buildEnrollRecoveryCall(account: Address): { to: Address; data: Hex } {
    return {
        to: account,
        data: encodeFunctionData({
            abi: justanAccountAbi,
            functionName: 'addOwnerAddress',
            args: [RECOVERY_MANAGER_ADDRESS],
        }),
    };
}

export function buildAddRecoveryCall(account: Address, method: RecoveryMethodInput): { to: Address; data: Hex } {
    const { provider, commitment, delay } = withProvider(method);
    return {
        to: RECOVERY_MANAGER_ADDRESS,
        data: encodeFunctionData({
            abi: RECOVERY_MANAGER_ABI,
            functionName: 'addRecovery',
            args: [account, provider, commitment, delay],
        }),
    };
}

export function buildRemoveRecoveryCall(account: Address, recoveryId: Hex): { to: Address; data: Hex } {
    return {
        to: RECOVERY_MANAGER_ADDRESS,
        data: encodeFunctionData({
            abi: RECOVERY_MANAGER_ABI,
            functionName: 'removeRecovery',
            args: [account, recoveryId],
        }),
    };
}

export function buildSetRecoveryThresholdCall(account: Address, threshold: number): { to: Address; data: Hex } {
    return {
        to: RECOVERY_MANAGER_ADDRESS,
        data: encodeFunctionData({
            abi: RECOVERY_MANAGER_ABI,
            functionName: 'setRecoveryThreshold',
            args: [account, BigInt(threshold)],
        }),
    };
}

/**
 * The single-chain veto, called by the account itself
 */
export function buildCancelRecoveryRequestCall(requestId: Hex): { to: Address; data: Hex } {
    return {
        to: RECOVERY_MANAGER_ADDRESS,
        data: encodeFunctionData({
            abi: RECOVERY_MANAGER_ABI,
            functionName: 'cancelRecoveryRequest',
            args: [requestId],
        }),
    };
}

/**
 * The account door: one userOp that enrols the manager when it is not an owner
 * yet, then applies every change the config needs, in the order the admin batch
 * would. The account pays like for any userOp, so this works on a chain where
 * the account has no code yet and the relayer cannot go. It is the first setup
 * on a chain and, for accounts that cannot use the admin door, every edit.
 *
 * @param current - The chain's config from the configs read; absent when the
 * backend lists nothing for the chain, which reads as nothing registered.
 */
export function buildRecoverySetupCalls(
    account: Address,
    current: RecoveryChainConfig | undefined,
    desired: RecoveryConfig
): Array<{ to: Address; data: Hex }> {
    const base = current ?? { chainId: 0, deployed: false, enrolled: false, threshold: 0, recoveries: [] };
    const calls: Array<{ to: Address; data: Hex }> = [];

    if (!base.enrolled) calls.push(buildEnrollRecoveryCall(account));

    for (const change of planRecoveryChanges(base, desired)) calls.push(changeToCall(account, change));

    return calls;
}

function apiKeyHeaders(apiKey?: string): { 'x-api-key'?: string } {
    return apiKey ? { 'x-api-key': apiKey } : {};
}

/**
 * The account's recovery state on every recovery-supported chain, read from the chain
 */
export async function getRecoveryConfig(account: Address, apiKey?: string): Promise<RecoveryConfigResponse> {
    return await restCall('GET_RECOVERY_CONFIG', 'GET', {}, apiKeyHeaders(apiKey), { account });
}

/**
 * Submit a signed admin batch. The backend dry-runs it on every chain, then
 * queues one relayer job per chain and answers with their initial status.
 */
export async function submitAdminBatch(request: SubmitAdminBatchRequest, apiKey?: string): Promise<AdminBatch> {
    return await restCall('SUBMIT_ADMIN_BATCH', 'POST', request, apiKeyHeaders(apiKey));
}

export async function getAdminBatch(id: Hex, apiKey?: string): Promise<AdminBatch> {
    return await restCall('GET_ADMIN_BATCH', 'GET', {}, apiKeyHeaders(apiKey), { id });
}

/**
 * Open a ceremony for a new owner. The backend sets the expiry.
 */
export async function createCeremony(request: CreateCeremonyRequest, apiKey?: string): Promise<CreatedCeremony> {
    return await restCall('CREATE_CEREMONY', 'POST', request, apiKeyHeaders(apiKey));
}

/**
 * Post a guardian's proof. The backend verifies it against the provider on
 * chain before counting it.
 */
export async function approveCeremony(
    requestId: Hex,
    request: ApproveCeremonyRequest,
    apiKey?: string
): Promise<CeremonyApproval> {
    return await restCall('APPROVE_CEREMONY', 'POST', request, apiKeyHeaders(apiKey), { requestId });
}

export async function getCeremony(requestId: Hex, apiKey?: string): Promise<Ceremony> {
    return await restCall('GET_CEREMONY', 'GET', {}, apiKeyHeaders(apiKey), { requestId });
}

/**
 * The account's ceremonies, newest first
 *
 * @param options.executed - true keeps the ceremonies executed on at least one chain, false the others
 */
export async function listCeremonies(
    account: Address,
    options?: { executed?: boolean },
    apiKey?: string
): Promise<CeremonyListEntry[]> {
    const response = await restCall(
        'LIST_CEREMONIES',
        'GET',
        { account, ...(options?.executed === undefined ? {} : { executed: options.executed ? 'true' : 'false' }) },
        apiKeyHeaders(apiKey)
    );
    return response.ceremonies;
}

const SETUP_METHOD = 'wallet_setupRecovery';
const CANCEL_METHOD = 'wallet_cancelRecovery';
const GET_METHOD = 'wallet_getRecovery';

/** The largest delay the manager stores: `addRecovery` takes a uint32 */
const MAX_RECOVERY_DELAY = 0xffffffff;

/**
 * A commitment as a dApp may send it: a 20-byte address, padded here to the
 * 32 bytes the signature provider compares against, or a 32-byte or 64-byte
 * value kept as it is. Refused here rather than inside an open dialog.
 */
function requireCommitment(value: unknown, method: string, field: string): Hex {
    if (isHexString(value)) {
        const length = size(value);
        if (length === 20) return pad(value, { size: 32 });
        if (length === 32 || length === 64) return value;
    }
    throw standardErrors.rpc.invalidParams(
        `${method}: ${field} must be a 20-byte address, a 32-byte padded address or a 64-byte public key`
    );
}

function requireDelay(value: unknown, method: string, field: string): number {
    // Bounded to the uint32 the manager stores: the ABI encoder would otherwise
    // throw an untyped error from inside the dialog instead of -32602 here.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_RECOVERY_DELAY) {
        throw standardErrors.rpc.invalidParams(
            `${method}: ${field} must be a whole number of seconds between 0 and ${MAX_RECOVERY_DELAY}`
        );
    }
    return value;
}

function requireThreshold(value: unknown, method: string): number {
    if (value === undefined || value === null) {
        throw standardErrors.rpc.invalidParams(`${method}: threshold is required`);
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw standardErrors.rpc.invalidParams(`${method}: threshold must be a positive integer`);
    }
    return value;
}

/**
 * The methods. An empty list is refused: a config with no methods can never be
 * valid, since the threshold must be at least one. A method repeated within the
 * list is refused too, because the manager rejects the second add.
 */
function requireRecoveries(value: unknown, method: string): RecoveryMethodInput[] {
    if (value === undefined || value === null) {
        throw standardErrors.rpc.invalidParams(`${method}: recoveries is required`);
    }
    if (!Array.isArray(value)) {
        throw standardErrors.rpc.invalidParams(`${method}: recoveries must be an array`);
    }
    if (value.length === 0) {
        throw standardErrors.rpc.invalidParams(`${method}: recoveries must not be empty`);
    }

    const seen = new Set<string>();
    return value.map((entry, index) => {
        const field = `recoveries[${index}]`;
        if (!isRecord(entry)) {
            throw standardErrors.rpc.invalidParams(`${method}: ${field} must be an object`);
        }
        const commitment = requireCommitment(entry.commitment, method, `${field}.commitment`);
        const delay = requireDelay(entry.delay, method, `${field}.delay`);
        const provider = optionalHexAddress(entry.provider, method, `${field}.provider`);

        const key = methodKey(provider ?? SIGNATURE_RECOVERY_PROVIDER_ADDRESS, commitment);
        if (seen.has(key)) {
            throw standardErrors.rpc.invalidParams(`${method}: ${field} repeats an earlier method`);
        }
        seen.add(key);

        return { commitment, delay, ...(provider && { provider }) };
    });
}

/**
 * Validates wallet_setupRecovery params. Runs in `validateSigningRequest`, so a
 * malformed or missing config is refused with -32602 before any dialog opens,
 * in both modes.
 *
 * The screen displays and approves, as for wallet_grantPermissions, so the
 * whole end state is required. Keys unrelated to it, such as an `address` or a
 * `chainId`, are not read.
 */
export function normalizeSetupRecoveryParams(params: unknown): NormalizedSetupRecoveryParams {
    const envelope = requireParamsObject(params, SETUP_METHOD);
    const recoveries = requireRecoveries(envelope.recoveries, SETUP_METHOD);
    const threshold = requireThreshold(envelope.threshold, SETUP_METHOD);

    if (threshold > recoveries.length) {
        throw standardErrors.rpc.invalidParams(
            `${SETUP_METHOD}: threshold ${threshold} exceeds the ${recoveries.length} recovery methods proposed`
        );
    }

    return { recoveries, threshold, capabilities: envelope.capabilities as RequestCapabilities | undefined };
}

/**
 * Validates wallet_cancelRecovery params.
 *
 * The veto is about one ceremony, so a missing request id is a malformed
 * request, not an absence: refused here with -32602 before any dialog opens,
 * the way `wallet_revokePermissions` refuses a missing permission id.
 */
export function normalizeCancelRecoveryParams(params: unknown): NormalizedCancelRecoveryParams {
    const envelope = requireParamsObject(params, CANCEL_METHOD);
    return {
        requestId: requireHexBytes32(envelope.requestId, CANCEL_METHOD, 'requestId'),
        capabilities: envelope.capabilities as RequestCapabilities | undefined,
    };
}

/**
 * Handle wallet_getRecovery request
 *
 * Reads the account named in the params, or the connected account when the
 * params name none; refuses when there is neither, as `wallet_getPermissions`
 * does. The address is checked before it goes into a request path.
 *
 * @param request - The wallet_getRecovery request
 * @param apiKey - API key for the recovery backend, if the caller has one
 * @param connectedAddress - Optional connected account address to inject if no address in params
 * @returns The config on every supported chain and the ceremonies not executed anywhere
 */
export async function handleGetRecoveryRequest(
    request: RequestArguments,
    apiKey: string | undefined,
    connectedAddress?: Address
): Promise<RecoveryState> {
    const params = request.params;
    const requested = Array.isArray(params) && isRecord(params[0]) ? params[0].address : undefined;
    const address = optionalHexAddress(requested, GET_METHOD, 'address') ?? connectedAddress;
    if (!address) {
        throw standardErrors.rpc.invalidParams({ message: `${GET_METHOD} requires an address parameter` });
    }

    const [{ chains }, pending] = await Promise.all([
        getRecoveryConfig(address, apiKey),
        listCeremonies(address, { executed: false }, apiKey),
    ]);
    return { chains, pending };
}

const ADMIN_OP_COMPONENTS = [
    { name: 'opType', type: 'uint8' },
    { name: 'data', type: 'bytes' },
] as const;

const RECOVERY_COMPONENTS = [
    { name: 'provider', type: 'address' },
    { name: 'commitment', type: 'bytes' },
    { name: 'delay', type: 'uint32' },
] as const;

/**
 * ABI for the JustaRecoveryManager contract
 */
export const RECOVERY_MANAGER_ABI = [
    {
        name: 'addRecovery',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'provider', type: 'address' },
            { name: 'commitment', type: 'bytes' },
            { name: 'delay', type: 'uint32' },
        ],
        outputs: [{ name: 'recoveryId', type: 'bytes32' }],
    },
    {
        name: 'removeRecovery',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'recoveryId', type: 'bytes32' },
        ],
        outputs: [],
    },
    {
        name: 'setRecoveryThreshold',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'threshold', type: 'uint256' },
        ],
        outputs: [],
    },
    {
        name: 'executeRecoveryAdmin',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'ops', type: 'tuple[]', components: ADMIN_OP_COMPONENTS },
            { name: 'salt', type: 'bytes32' },
            { name: 'expiry', type: 'uint256' },
            { name: 'ownerBytes', type: 'bytes' },
            { name: 'proof', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        name: 'requestRecovery',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'subject', type: 'bytes' },
            { name: 'salt', type: 'bytes32' },
            { name: 'expiry', type: 'uint256' },
            {
                name: 'approvals',
                type: 'tuple[]',
                components: [
                    { name: 'recoveryId', type: 'bytes32' },
                    { name: 'proof', type: 'bytes' },
                ],
            },
        ],
        outputs: [{ name: 'requestId', type: 'bytes32' }],
    },
    {
        name: 'executeRecoveryRequest',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'requestId', type: 'bytes32' }],
        outputs: [],
    },
    {
        name: 'cancelRecoveryRequest',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'requestId', type: 'bytes32' }],
        outputs: [],
    },
    {
        name: 'computeRecoveryId',
        type: 'function',
        stateMutability: 'pure',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'provider', type: 'address' },
            { name: 'commitment', type: 'bytes' },
        ],
        outputs: [{ name: '', type: 'bytes32' }],
    },
    {
        name: 'hasRecovery',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'recoveryId', type: 'bytes32' },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        name: 'getRecoveries',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: 'recoveries', type: 'tuple[]', components: RECOVERY_COMPONENTS }],
    },
    {
        name: 'getRecovery',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'recoveryId', type: 'bytes32' },
        ],
        outputs: [{ name: '', type: 'tuple', components: RECOVERY_COMPONENTS }],
    },
    {
        name: 'recoveryCount',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'recoveryThreshold',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'isSaltUsed',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'salt', type: 'bytes32' },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        name: 'recoveryAdminDigest',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'ops', type: 'tuple[]', components: ADMIN_OP_COMPONENTS },
            { name: 'salt', type: 'bytes32' },
            { name: 'expiry', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bytes32' }],
    },
    {
        name: 'recoveryRequest',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'requestId', type: 'bytes32' }],
        outputs: [
            {
                name: '',
                type: 'tuple',
                components: [
                    { name: 'account', type: 'address' },
                    { name: 'executeAt', type: 'uint64' },
                    { name: 'subject', type: 'bytes' },
                ],
            },
        ],
    },
] as const;

/**
 * ABI for the SignatureRecoveryProvider contract
 */
export const SIGNATURE_RECOVERY_PROVIDER_ABI = [
    {
        name: 'verify',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'subject', type: 'bytes' },
            { name: 'salt', type: 'bytes32' },
            { name: 'expiry', type: 'uint256' },
            { name: 'commitment', type: 'bytes' },
            { name: 'proof', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        name: 'recoverDigest',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'subject', type: 'bytes' },
            { name: 'salt', type: 'bytes32' },
            { name: 'expiry', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bytes32' }],
    },
] as const;

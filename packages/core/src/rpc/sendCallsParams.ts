import type { Address } from '../provider/interface.js';
import { standardErrors } from '../errors/index.js';
import type { RequestCapabilities } from './permissions.js';
import {
    describeValue,
    isRecord,
    optionalChainId,
    optionalHexAddress,
    optionalHexData,
    optionalHexQuantity,
    requireHexAddress,
    requireParamsObject,
} from './paramUtils.js';

const METHOD = 'wallet_sendCalls';

/**
 * EIP-5792 request envelope versions accepted by wallet_sendCalls.
 *
 * `1.0` is the original envelope; `2.0.0` is what viem's `sendCalls()` — and
 * therefore wagmi — sends by default. Both map onto the same pipeline: the
 * version only ever changed the envelope, never the semantics of a batch.
 */
export const SUPPORTED_SEND_CALLS_VERSIONS = ['1.0', '2.0.0'] as const;

export type SendCallsVersion = (typeof SUPPORTED_SEND_CALLS_VERSIONS)[number];

/** A single call, with `undefined` fields dropped so the envelope serializes cleanly. */
export interface NormalizedCall {
    to: string;
    data?: string;
    value?: string;
}

/**
 * A wallet_sendCalls envelope after validation: version-tagged, chainId in hex,
 * atomicRequired always present.
 */
export interface NormalizedSendCallsParams {
    version: SendCallsVersion;
    from?: Address;
    /** Hex chainId, or undefined when the dapp left the chain to the wallet. */
    chainId?: `0x${string}`;
    calls: NormalizedCall[];
    atomicRequired: boolean;
    capabilities?: RequestCapabilities;
}

/**
 * Capabilities wallet_sendCalls implements. A capability outside this set that
 * the dapp did not mark `optional` is refused with EIP-5792 5700 — silently
 * dropping it would execute a batch whose terms differ from what was asked for.
 */
const SUPPORTED_SEND_CALLS_CAPABILITIES = ['paymasterService', 'permissions'];

function assertCapabilitiesSupported(capabilities: Record<string, unknown>): void {
    const unsupported = Object.entries(capabilities)
        .filter(([name, capability]) => {
            if (SUPPORTED_SEND_CALLS_CAPABILITIES.includes(name)) return false;
            // Absent `optional` means required (EIP-5792), so an unknown
            // capability is only ignorable when it opts out explicitly.
            return !(isRecord(capability) && capability.optional === true);
        })
        .map(([name]) => name);

    if (unsupported.length > 0) {
        throw standardErrors.provider.unsupportedNonOptionalCapability(
            `wallet_sendCalls: unsupported non-optional capabilities: ${unsupported.join(', ')}. Supported: ${SUPPORTED_SEND_CALLS_CAPABILITIES.join(', ')}`
        );
    }
}

function normalizeCall(call: unknown, index: number): NormalizedCall {
    if (!isRecord(call)) {
        throw standardErrors.rpc.invalidParams(`${METHOD}: calls[${index}] must be an object`);
    }

    // EIP-5792 leaves `to` optional (contract creation), but an ERC-4337
    // `execute` always needs a target — so reject it here with a reason instead
    // of failing deeper in the userOp build.
    const to = requireHexAddress(call.to, METHOD, `calls[${index}].to`);
    const data = optionalHexData(call.data, METHOD, `calls[${index}].data`);
    const value = optionalHexQuantity(call.value, METHOD, `calls[${index}].value`);

    return {
        to,
        ...(data !== undefined && { data }),
        ...(value !== undefined && { value }),
    };
}

/**
 * Validates and normalizes wallet_sendCalls params for both EIP-5792 envelope
 * versions, so a stock viem/wagmi dapp (v2.0.0, hex chainId, capabilities) and a
 * hand-built v1.0 envelope produce the same internal request.
 *
 * Anything malformed — including an envelope version we don't implement — throws
 * `-32602` with a message naming the problem, so dapps can tell a capability gap
 * apart from a rejected batch.
 */
export function normalizeSendCallsParams(params: unknown): NormalizedSendCallsParams {
    const envelope = requireParamsObject(params, METHOD);

    // An absent version means a pre-2.0.0 dapp: EIP-5792 v1.0 shipped before
    // the field was mandatory, so default rather than reject.
    const version = envelope.version ?? '1.0';
    if (!SUPPORTED_SEND_CALLS_VERSIONS.includes(version as SendCallsVersion)) {
        throw standardErrors.rpc.invalidParams(
            `${METHOD}: unsupported version ${describeValue(version)}. Supported versions: ${SUPPORTED_SEND_CALLS_VERSIONS.join(', ')}`
        );
    }

    const { calls } = envelope;
    if (!Array.isArray(calls) || calls.length === 0) {
        throw standardErrors.rpc.invalidParams(`${METHOD}: calls must be a non-empty array`);
    }

    const from = optionalHexAddress(envelope.from, METHOD, 'from');

    const atomicRequired = envelope.atomicRequired;
    if (atomicRequired !== undefined && typeof atomicRequired !== 'boolean') {
        throw standardErrors.rpc.invalidParams(`${METHOD}: atomicRequired must be a boolean`);
    }

    const capabilities = envelope.capabilities;
    if (capabilities !== undefined && capabilities !== null && !isRecord(capabilities)) {
        throw standardErrors.rpc.invalidParams(`${METHOD}: capabilities must be an object`);
    }
    if (isRecord(capabilities)) {
        assertCapabilitiesSupported(capabilities);
    }

    const chainId = optionalChainId(envelope.chainId, METHOD);

    return {
        version: version as SendCallsVersion,
        ...(from !== undefined && { from }),
        ...(chainId !== undefined && { chainId }),
        calls: calls.map(normalizeCall),
        // ERC-4337 executes a batch in a single UserOperation, so atomicity is
        // always satisfied — `atomicRequired: true` never needs to be refused.
        atomicRequired: atomicRequired ?? false,
        ...(capabilities ? { capabilities: capabilities as RequestCapabilities } : {}),
    };
}

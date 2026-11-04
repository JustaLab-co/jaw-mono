/**
 * Golden vectors for the recovery encoders and digests, against bytes produced
 * outside TypeScript.
 *
 * recovery.property.test.ts pins the op encodings by decoding them with an ABI
 * written from the Solidity, which proves the two directions agree and nothing
 * more. The `expected` here was produced by `cast`: `cast abi-encode` for the
 * op payloads, `cast calldata` for the account-door calls (selector included),
 * and `cast call` against the deployed contracts' own view functions for the
 * digests and ids, so a digest is the contract's statement of what an owner or
 * guardian signs. See vectors/README.md for the exact commands.
 *
 * The digests also pin the two addresses in constants.ts, because the domain
 * carries `verifyingContract`: a redeploy at another address regenerates these
 * entries, and says so in the PR.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { hashTypedData, type Address, type Hex } from 'viem';

import {
    addRecoveryOp,
    buildAddRecoveryCall,
    buildCancelRecoveryRequestCall,
    buildEnrollRecoveryCall,
    buildRemoveRecoveryCall,
    buildSetRecoveryThresholdCall,
    cancelRequestOp,
    computeRecoveryId,
    computeRequestId,
    recoverTypedData,
    recoveryAdminTypedData,
    removeRecoveryOp,
    setThresholdOp,
    type AdminOp,
    type RecoveryMethodInput,
} from './recovery.js';

/**
 * Discriminated on `encoder` so a vector cannot quietly reach the wrong builder.
 */
type Vector = { description: string; expected: Hex } & (
    | { encoder: 'addRecoveryOp'; input: RecoveryMethodInput }
    | { encoder: 'removeRecoveryOp'; input: { recoveryId: Hex } }
    | { encoder: 'setThresholdOp'; input: { threshold: number } }
    | { encoder: 'cancelRequestOp'; input: { requestId: Hex } }
    | { encoder: 'buildEnrollRecoveryCall'; input: { account: Address } }
    | { encoder: 'buildAddRecoveryCall'; input: { account: Address; method: RecoveryMethodInput } }
    | { encoder: 'buildRemoveRecoveryCall'; input: { account: Address; recoveryId: Hex } }
    | { encoder: 'buildSetRecoveryThresholdCall'; input: { account: Address; threshold: number } }
    | { encoder: 'buildCancelRecoveryRequestCall'; input: { requestId: Hex } }
    | { encoder: 'recoveryAdminDigest'; input: { account: Address; ops: AdminOp[]; salt: Hex; expiry: number } }
    | { encoder: 'recoverDigest'; input: { account: Address; subject: Hex; salt: Hex; expiry: number } }
    | { encoder: 'computeRecoveryId'; input: { account: Address; provider: Address; commitment: Hex } }
    | { encoder: 'computeRequestId'; input: { account: Address; subject: Hex; salt: Hex } }
);

/** Read rather than imported, so the vectors stay plain data with no build wiring. */
const vectors: Vector[] = JSON.parse(
    readFileSync(new URL('../../vectors/recovery-calls.json', import.meta.url), 'utf8')
);

function encode(vector: Vector): Hex {
    switch (vector.encoder) {
        case 'addRecoveryOp':
            return addRecoveryOp(vector.input).data;
        case 'removeRecoveryOp':
            return removeRecoveryOp(vector.input.recoveryId).data;
        case 'setThresholdOp':
            return setThresholdOp(vector.input.threshold).data;
        case 'cancelRequestOp':
            return cancelRequestOp(vector.input.requestId).data;
        case 'buildEnrollRecoveryCall':
            return buildEnrollRecoveryCall(vector.input.account).data;
        case 'buildAddRecoveryCall':
            return buildAddRecoveryCall(vector.input.account, vector.input.method).data;
        case 'buildRemoveRecoveryCall':
            return buildRemoveRecoveryCall(vector.input.account, vector.input.recoveryId).data;
        case 'buildSetRecoveryThresholdCall':
            return buildSetRecoveryThresholdCall(vector.input.account, vector.input.threshold).data;
        case 'buildCancelRecoveryRequestCall':
            return buildCancelRecoveryRequestCall(vector.input.requestId).data;
        case 'recoveryAdminDigest':
            return hashTypedData(recoveryAdminTypedData(vector.input));
        case 'recoverDigest':
            return hashTypedData(recoverTypedData(vector.input));
        case 'computeRecoveryId':
            return computeRecoveryId(vector.input.account, vector.input.provider, vector.input.commitment);
        case 'computeRequestId':
            return computeRequestId(vector.input.account, vector.input.subject, vector.input.salt);
        default:
            // The union above is compile-time only, and the vectors arrive
            // through JSON.parse. Say which name is wrong rather than letting a
            // typo return undefined and fail as a byte mismatch.
            throw new Error(`Unknown encoder in recovery-calls.json: ${(vector as Vector).encoder}`);
    }
}

describe('the recovery encodings and digests, against vectors from the contracts', () => {
    it.each(vectors)('$description', (vector) => {
        expect(encode(vector)).toBe(vector.expected);
    });

    it('the enroll call is addressed to the account itself, not the manager', () => {
        const account = '0x1111111111111111111111111111111111111111';
        expect(buildEnrollRecoveryCall(account).to).toBe(account);
    });
});

import { evaluatePrf, type EvaluatePrfOptions } from './evaluate.js';
import { assertPrfLabel, deriveKeyFromPrf } from './derive.js';
import type { PasskeyOwnershipProof } from '../passkey-manager/ownershipProof.js';

export { PrfUnavailableError, PRF_SALT_V1, type EvaluatePrfOptions } from './evaluate.js';
export { PRF_HKDF_SALT_V1 } from './derive.js';

/**
 * Prompt once for the account's passkey and derive one 32-byte key per label.
 * The PRF output stays inside this function and is zeroed before it returns,
 * so callers only ever hold derived keys.
 *
 * Cross-platform mode only: it is exported from `@jaw.id/core/internal` for
 * keys.jaw.id, where the passkey's PRF output is the same for every app. It is
 * not offered in app-specific mode, where the output would land in the app's page.
 *
 * @param labels - Versioned key labels, `jaw.id/<use>/v<N>`; checked before prompting
 * @returns The derived keys by label, which the caller should zero after use,
 * and the prompt's ownership proof, for recording PRF support on the passkey server.
 * @throws {PrfUnavailableError} If the passkey returned no PRF result
 * @throws {WebAuthnAuthenticationError} If the prompt failed or was cancelled
 */
export async function derivePrfKeys<const L extends string>(
    options: EvaluatePrfOptions,
    labels: readonly L[]
): Promise<{ keys: Record<L, Uint8Array>; proof?: PasskeyOwnershipProof }> {
    if (labels.length === 0) throw new Error('At least one key label is required');
    labels.forEach(assertPrfLabel);

    const { output: prfOutput, proof } = await evaluatePrf(options);
    const keys = {} as Record<L, Uint8Array>;
    try {
        for (const label of labels) keys[label] = await deriveKeyFromPrf(prfOutput, label);
        return { keys, proof };
    } catch (error) {
        for (const key of Object.values<Uint8Array>(keys)) key.fill(0);
        throw error;
    } finally {
        prfOutput.fill(0);
    }
}

/**
 * Which networks a recovery change can be relayed to, and why the others
 * can't. The backend rejects a whole batch when one network named in it fails
 * its dry run, so only networks where the batch passes are `ready`.
 */
import { describe, expect, it } from 'vitest';
import { planRecoveryNetworks, toOwnerBytes, computeRecoveryId, type RecoveryChainConfig } from './recovery.js';
import { SIGNATURE_RECOVERY_PROVIDER_ADDRESS } from '../constants.js';

const ACCOUNT = '0x201bcE6e444BA385F9c79d972D6b8E7dCc58e98c' as const;
const PROVIDER = SIGNATURE_RECOVERY_PROVIDER_ADDRESS;
const A = toOwnerBytes('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const B = toOwnerBytes('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const CONNECTED = 84_532;

function method(commitment: `0x${string}`, delay = 60) {
    return { recoveryId: computeRecoveryId(ACCOUNT, PROVIDER, commitment), provider: PROVIDER, commitment, delay };
}

function chain(chainId: number, overrides: Partial<RecoveryChainConfig> = {}): RecoveryChainConfig {
    return { chainId, deployed: true, enrolled: true, threshold: 1, recoveries: [method(A)], ...overrides };
}

const NOT_DEPLOYED = { deployed: false, enrolled: false, threshold: 0, recoveries: [] };

/** The signing key owns the account on every network listed. */
function owners(...chainIds: number[]) {
    return new Map(chainIds.map((chainId) => [chainId, true]));
}

describe('planRecoveryNetworks', () => {
    it('says why each network can or cannot take the change, in the order given', () => {
        const chains = [
            chain(CONNECTED),
            chain(10, NOT_DEPLOYED),
            chain(8453, { enrolled: false, threshold: 0, recoveries: [] }),
            chain(42_161),
        ];

        const plan = planRecoveryNetworks(
            chains,
            new Map([
                [CONNECTED, true],
                [42_161, false],
            ]),
            CONNECTED
        );

        expect(plan.networks.map(({ chainId, status }) => [chainId, status])).toEqual([
            [CONNECTED, 'ready'],
            [10, 'not-deployed'],
            [8453, 'not-available'],
            [42_161, 'not-owner'],
        ]);
    });

    it('treats a network with no owner read as one the key does not own', () => {
        const plan = planRecoveryNetworks([chain(CONNECTED), chain(10)], owners(CONNECTED), CONNECTED);

        expect(plan.networks[1].status).toBe('not-owner');
    });

    it('plans from the connected network when it is ready', () => {
        const connected = chain(CONNECTED, { recoveries: [method(A), method(B)], threshold: 2 });
        const plan = planRecoveryNetworks([chain(10), connected], owners(10, CONNECTED), CONNECTED);

        expect(plan.base).toEqual(connected);
        expect(plan.networks.map(({ status }) => status)).toEqual(['out-of-sync', 'ready']);
    });

    it('plans from the first ready network when the connected one is not ready', () => {
        const plan = planRecoveryNetworks(
            [chain(CONNECTED, NOT_DEPLOYED), chain(10), chain(8453)],
            owners(10, 8453),
            CONNECTED
        );

        expect(plan.base?.chainId).toBe(10);
        expect(plan.networks.map(({ status }) => status)).toEqual(['not-deployed', 'ready', 'ready']);
    });

    it('plans from the first ready network when the connected one does not support recovery', () => {
        const plan = planRecoveryNetworks([chain(10), chain(8453)], owners(10, 8453), 1);

        expect(plan.base?.chainId).toBe(10);
    });

    it.each([
        ['another guardian', { recoveries: [method(B)] }],
        ['another wait', { recoveries: [method(A, 120)] }],
        ['another threshold', { recoveries: [method(A), method(B)], threshold: 2 }],
        ['no guardians yet', { threshold: 0, recoveries: [] }],
    ])('marks a network with %s as out of sync with the base', (_, change) => {
        const plan = planRecoveryNetworks([chain(CONNECTED), chain(10, change)], owners(CONNECTED, 10), CONNECTED);

        expect(plan.networks[1].status).toBe('out-of-sync');
    });

    it('treats the same guardians in another order as in sync', () => {
        const plan = planRecoveryNetworks(
            [
                chain(CONNECTED, { recoveries: [method(A), method(B)] }),
                chain(10, { recoveries: [method(B), method(A)] }),
            ],
            owners(CONNECTED, 10),
            CONNECTED
        );

        expect(plan.networks[1].status).toBe('ready');
    });

    it('has no base when no network is ready, so nothing can be relayed', () => {
        const plan = planRecoveryNetworks(
            [chain(CONNECTED, NOT_DEPLOYED), chain(10, { enrolled: false, threshold: 0, recoveries: [] })],
            new Map(),
            CONNECTED
        );

        expect(plan.base).toBeUndefined();
        expect(plan.networks.map(({ status }) => status)).toEqual(['not-deployed', 'not-available']);
    });
});

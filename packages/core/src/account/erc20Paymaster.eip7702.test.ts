import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import type { LocalAccount } from 'viem/accounts';
import type { SmartAccount } from 'viem/account-abstraction';
import { abi } from './toJustanAccount.js';
import { estimateErc20PaymasterCosts } from './erc20Paymaster.js';

const prepareUserOperation = vi.fn();

vi.mock('viem/actions', async (original) => ({
    ...(await original<object>()),
    readContract: vi.fn(async () => '0x00000000000000000000000000000000000000aa'),
    call: vi.fn(async () => ({ data: `0x${'0'.repeat(64)}` })),
}));
vi.mock('./delegation.js', () => ({ isDelegatedToImplementation: vi.fn(async () => false) }));
vi.mock('./userOpGasSimulation.js', () => ({ simulateUserOpGasUsage: vi.fn(async () => null) }));
vi.mock('./smartAccount.js', async (original) => ({
    ...(await original<object>()),
    getBundlerClient: () => ({ prepareUserOperation }),
}));

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
const PAYER = '0x30f1d66cc29444B7B6576BC05a83A00339502152' as Address;
const AUTHORIZATION = { address: PAYER, chainId: 84532, nonce: 0, r: '0x1', s: '0x2', yParity: 0 };
const chain = { id: 84532, rpcUrl: 'http://127.0.0.1:9' } as Parameters<typeof estimateErc20PaymasterCosts>[2];
const smartAccount = {
    address: PAYER,
    entryPoint: { address: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' },
    signAuthorization: async () => AUTHORIZATION,
} as unknown as SmartAccount;
const transfer = { to: TOKEN, data: '0xa9059cbb' as Hex };

function stubPaymaster() {
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        result: {
                            quotes: [
                                {
                                    token: TOKEN,
                                    postOpGas: '1',
                                    exchangeRate: '1',
                                    paymaster: '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402',
                                },
                            ],
                        },
                    })
                )
        )
    );
    prepareUserOperation.mockResolvedValue({
        preVerificationGas: 1n,
        verificationGasLimit: 1n,
        callGasLimit: 1n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
    });
}

const tokens = [{ address: TOKEN, symbol: 'USDC', decimals: 6, balance: 0n }];

describe('given a 7702 payer that is not delegated yet', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        prepareUserOperation.mockReset();
    });

    it('when its fee is estimated with the local account, then it prices the delegation a fresh payer still needs', async () => {
        stubPaymaster();

        await estimateErc20PaymasterCosts(smartAccount, [transfer], chain, 'https://pm.test', tokens, {
            localAccount: { address: PAYER } as LocalAccount,
        });

        const { calls, authorization } = prepareUserOperation.mock.calls[0][0];
        expect(authorization).toEqual(AUTHORIZATION);
        expect(calls[0].to).toBe(PAYER);
        expect(decodeFunctionData({ abi, data: calls[0].data }).functionName).toBe('addOwnerAddress');
        expect(calls.slice(-1)[0]).toMatchObject(transfer);
    });

    it('when its fee is estimated without one, then it prices the calls alone, as before', async () => {
        stubPaymaster();

        await estimateErc20PaymasterCosts(smartAccount, [transfer], chain, 'https://pm.test', tokens);

        const { calls, authorization } = prepareUserOperation.mock.calls[0][0];
        expect(authorization).toBeUndefined();
        expect(calls).toHaveLength(2);
    });

    it('when its fee is estimated without one, then a target it accepted before is passed through as given', async () => {
        stubPaymaster();
        // Mixed case with a wrong checksum: getAddress rejects it, the estimate never checked it.
        const target = '0x036cbd53842c5426634e7929541eC2318f3dCF7e' as Address;

        await estimateErc20PaymasterCosts(
            smartAccount,
            [{ ...transfer, to: target }],
            chain,
            'https://pm.test',
            tokens
        );

        expect(prepareUserOperation.mock.calls[0][0].calls[1].to).toBe(target);
    });

    it('when a permission is also given, then the type refuses the local account it would ignore', () => {
        const both = () =>
            estimateErc20PaymasterCosts(smartAccount, [transfer], chain, 'https://pm.test', tokens, {
                permissionId: '0x01',
                // @ts-expect-error a permission send is priced through the permissions manager, not as a 7702 sender
                localAccount: { address: PAYER } as LocalAccount,
            });
        expect(both).toBeTypeOf('function');
    });
});

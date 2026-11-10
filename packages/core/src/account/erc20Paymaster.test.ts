import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { entryPoint08Abi, entryPoint08Address, type SmartAccount } from 'viem/account-abstraction';
import { setDappOrigin } from '../dappOrigin.js';
import { JAW_PAYMASTER_URL } from '../constants.js';
import {
    buildErc20PaymasterContext,
    calculateDisplayTokenCost,
    calculateTokenCostFromGas,
    calculateTokenEstimatesFromGas,
    computeEffectiveGasPrice,
    computeMeasuredDisplayGas,
    Erc20EstimationError,
    estimateErc20PaymasterCosts,
    fetchTokenQuotes,
    type TokenInfo,
    type TokenQuote,
    type UserOpGasFields,
} from './erc20Paymaster.js';

// The permission relay is reached through axios, which in node does not go
// through fetch.
const relayRequest = vi.fn();
vi.mock('../api/axiosController.js', async () => {
    const actual = await vi.importActual<typeof import('../api/axiosController.js')>('../api/axiosController.js');
    return { ...actual, backendInstance: () => ({ request: relayRequest }) };
});

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const PAYMASTER = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402' as const;

// Round numbers so expected costs are exact
const gas: UserOpGasFields = {
    preVerificationGas: 50_000n,
    verificationGasLimit: 60_000n,
    callGasLimit: 70_000n,
    paymasterVerificationGasLimit: 40_000n,
    paymasterPostOpGasLimit: 69_000n,
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 2n,
};

const quote: TokenQuote = {
    tokenAddress: TOKEN,
    postOpGas: 19_000n,
    // 1 wei of gas -> 1 smallest token unit, so costs equal wei numbers
    exchangeRate: BigInt(1e18),
    paymasterAddress: PAYMASTER,
};

describe('calculateTokenCostFromGas (worst-case ceiling)', () => {
    it('sums ALL five gas limits plus the quoted postOp gas at maxFeePerGas', () => {
        // (50k + 60k + 70k + 40k + 69k + 19k) * 100 = 30_800_000
        expect(calculateTokenCostFromGas(gas, quote)).toBe(30_800_000n);
    });

    it('treats missing paymaster gas limits as zero', () => {
        const legacyGas: UserOpGasFields = {
            preVerificationGas: 50_000n,
            verificationGasLimit: 60_000n,
            callGasLimit: 70_000n,
            maxFeePerGas: 100n,
        };
        // (180k + 19k) * 100
        expect(calculateTokenCostFromGas(legacyGas, quote)).toBe(19_900_000n);
    });

    it('converts through the exchange rate', () => {
        const halfRate = { ...quote, exchangeRate: BigInt(5e17) };
        expect(calculateTokenCostFromGas(gas, halfRate)).toBe(15_400_000n);
    });
});

describe('calculateDisplayTokenCost (realistic estimate)', () => {
    it('excludes the padded paymasterPostOpGasLimit and counts the quoted postOp once', () => {
        // (50k + 60k + 70k + 40k + 19k) * 100 = 23_900_000 — no 69k stub
        expect(calculateDisplayTokenCost(gas, quote)).toBe(23_900_000n);
    });

    it('prices at the provided gas price instead of maxFeePerGas', () => {
        // 239_000 gas * 40 = 9_560_000
        expect(calculateDisplayTokenCost(gas, quote, { gasPrice: 40n })).toBe(9_560_000n);
    });

    it('is always below the ceiling for the same gas price', () => {
        expect(calculateDisplayTokenCost(gas, quote)).toBeLessThan(calculateTokenCostFromGas(gas, quote));
    });

    it('bounds the postOp term by the userOp postOp limit if the quote ever exceeds it', () => {
        const oversizedQuote = { ...quote, postOpGas: 100_000n }; // > pmPostOpGL (69k)
        // (50k + 60k + 70k + 40k + 69k) * 100 — the limit wins over the quote
        expect(calculateDisplayTokenCost(gas, oversizedQuote)).toBe(28_900_000n);
    });

    it('uses measured gas instead of the summed limits when provided', () => {
        // (100k measured + 19k postOp) * 100 = 11_900_000 — limits ignored
        expect(calculateDisplayTokenCost(gas, quote, { measuredGas: 100_000n })).toBe(11_900_000n);
    });
});

describe('computeMeasuredDisplayGas', () => {
    it('combines pVG, the pm verification limit, split-buffered phases, and EP overhead', () => {
        // 50k pVG + 40k pmVerGL + 30k*1.05 + 50k*1.10 + 25k EP (unused callGas 20k < 40k -> no penalty)
        const measured = { verificationGasUsed: 30_000n, executionGasUsed: 50_000n };
        expect(computeMeasuredDisplayGas(gas, measured)).toBe(201_500n);
    });

    it('treats a missing paymaster verification limit as zero', () => {
        const noPmGas = { ...gas, paymasterVerificationGasLimit: undefined };
        // 50k + 0 + 31_500 + 55_000 + 25k
        expect(computeMeasuredDisplayGas(noPmGas, { verificationGasUsed: 30_000n, executionGasUsed: 50_000n })).toBe(
            161_500n
        );
    });

    it('adds the EntryPoint unused-callGas penalty when the gap exceeds 40k', () => {
        // callGasLimit 200k - 50k measured = 150k unused > 40k -> +15k penalty
        const paddedGas = { ...gas, callGasLimit: 200_000n };
        // 50k + 40k + 31_500 + 55_000 + 25k + 15_000
        expect(computeMeasuredDisplayGas(paddedGas, { verificationGasUsed: 30_000n, executionGasUsed: 50_000n })).toBe(
            216_500n
        );
    });
});

describe('buildErc20PaymasterContext', () => {
    it('uses the ceiling (tokenCostMax) as the approve amount, not the display cost', () => {
        const tokens: TokenInfo[] = [{ address: TOKEN, symbol: 'USDC', decimals: 6, balance: 40_000_000n }];
        const [est] = calculateTokenEstimatesFromGas(gas, [quote], tokens, { displayGasPrice: 52n });
        const context = buildErc20PaymasterContext(est);
        expect(context.token).toBe(TOKEN);
        expect(context.gas).toBe(est.tokenCostMax.toString());
        expect(context.gas).not.toBe(est.tokenCost.toString());
    });
});

describe('computeEffectiveGasPrice', () => {
    it('returns buffered base fee plus priority when under the ceiling', () => {
        // 40 * 1.25 + 2 = 52
        expect(computeEffectiveGasPrice(gas, 40n)).toBe(52n);
    });

    it('caps at maxFeePerGas', () => {
        expect(computeEffectiveGasPrice(gas, 1_000n)).toBe(gas.maxFeePerGas);
    });

    it('handles a missing priority fee', () => {
        expect(computeEffectiveGasPrice({ maxFeePerGas: 100n }, 40n)).toBe(50n);
    });

    it('accepts a custom buffer', () => {
        // 40 * 2.0 + 2 = 82
        expect(computeEffectiveGasPrice(gas, 40n, 20_000n)).toBe(82n);
    });
});

describe('calculateTokenEstimatesFromGas', () => {
    const tokens: TokenInfo[] = [{ address: TOKEN, symbol: 'USDC', decimals: 6, balance: 40_000_000n }];

    it('returns the realistic cost as tokenCost and the ceiling as tokenCostMax', () => {
        const [est] = calculateTokenEstimatesFromGas(gas, [quote], tokens, { displayGasPrice: 52n });
        // display: 239_000 * 52 = 12_428_000 | max: 308_000 * 100 = 30_800_000
        expect(est.tokenCost).toBe(12_428_000n);
        expect(est.tokenCostMax).toBe(30_800_000n);
        expect(est.tokenCostFormatted).toBe('12.43');
        expect(est.tokenCostMaxFormatted).toBe('30.80');
    });

    it('falls back to ceiling-priced display when no effective price is available', () => {
        const [est] = calculateTokenEstimatesFromGas(gas, [quote], tokens);
        expect(est.tokenCost).toBe(23_900_000n);
        expect(est.tokenCostMax).toBe(30_800_000n);
    });

    it('never displays more than the ceiling', () => {
        const [est] = calculateTokenEstimatesFromGas(gas, [quote], tokens, { displayGasPrice: 1_000n });
        expect(est.tokenCost).toBe(est.tokenCostMax);
    });

    it('prices the display from measured gas when provided', () => {
        const [est] = calculateTokenEstimatesFromGas(gas, [quote], tokens, {
            displayGasPrice: 52n,
            measuredGas: 174_000n,
        });
        // (174k + 19k) * 52 = 10_036_000; ceiling untouched
        expect(est.tokenCost).toBe(10_036_000n);
        expect(est.tokenCostMax).toBe(30_800_000n);
    });

    it('caps a measured display at the ceiling', () => {
        const [est] = calculateTokenEstimatesFromGas(gas, [quote], tokens, { measuredGas: 10_000_000n });
        expect(est.tokenCost).toBe(est.tokenCostMax);
    });

    it('checks balance against the ceiling, not the displayed estimate', () => {
        // Balance covers the display (12.4) but not the ceiling (30.8)
        const poor: TokenInfo[] = [{ address: TOKEN, symbol: 'USDC', decimals: 6, balance: 20_000_000n }];
        const [est] = calculateTokenEstimatesFromGas(gas, [quote], poor, { displayGasPrice: 52n });
        expect(est.hasSufficientBalance).toBe(false);

        const rich: TokenInfo[] = [{ address: TOKEN, symbol: 'USDC', decimals: 6, balance: 30_800_000n }];
        const [ok] = calculateTokenEstimatesFromGas(gas, [quote], rich, { displayGasPrice: 52n });
        expect(ok.hasSufficientBalance).toBe(true);
    });

    it('matches tokens case-insensitively and defaults unknown tokens', () => {
        const lower: TokenInfo[] = [
            { address: TOKEN.toLowerCase() as TokenInfo['address'], symbol: 'USDC', decimals: 6, balance: 0n },
        ];
        const [est] = calculateTokenEstimatesFromGas(gas, [quote], lower);
        expect(est.symbol).toBe('USDC');

        const [unknown] = calculateTokenEstimatesFromGas(gas, [quote], []);
        expect(unknown.symbol).toBe('UNKNOWN');
        expect(unknown.decimals).toBe(18);
        expect(unknown.hasSufficientBalance).toBe(false);
    });

    it('respects zero-decimal tokens instead of coercing them to 18', () => {
        const zeroDec: TokenInfo[] = [{ address: TOKEN, symbol: 'PTS', decimals: 0, balance: 40_000_000n }];
        const [est] = calculateTokenEstimatesFromGas(gas, [quote], zeroDec);
        expect(est.decimals).toBe(0);
        // 23_900_000 smallest units at 0 decimals => "23900000.00", never "0.0000"
        expect(est.tokenCostFormatted).toBe('23900000.00');
    });
});

// The quotes are the first call `estimateErc20PaymasterCosts` makes, and the only
// one to our proxy that went out without saying which dApp it acts for. Keyless
// that leaves nothing to attribute it to, and the proxy turns it down.
describe('fetchTokenQuotes and the calling dApp', () => {
    const QUOTES = {
        jsonrpc: '2.0',
        id: 1,
        result: { quotes: [{ token: '0xabc', postOpGas: '1', exchangeRate: '2', paymaster: '0xdef' }] },
    };

    function headersSent(): Record<string, string> {
        return (vi.mocked(globalThis.fetch).mock.calls[0][1] as { headers: Record<string, string> }).headers;
    }

    afterEach(() => {
        setDappOrigin(undefined);
        vi.unstubAllGlobals();
    });

    it('names the dApp on a quote from our proxy', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify(QUOTES)))
        );
        setDappOrigin('https://dapp.example');

        await fetchTokenQuotes(`${JAW_PAYMASTER_URL}?chainId=8453`, 8453, ['0xabc']);

        expect(headersSent()['x-dapp-origin']).toBe('https://dapp.example');
    });

    it('sends no dApp header to a paymaster the dApp pointed us at', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify(QUOTES)))
        );
        setDappOrigin('https://dapp.example');

        await fetchTokenQuotes('https://paymaster.dapp.example', 8453, ['0xabc']);

        expect(headersSent()['x-dapp-origin']).toBeUndefined();
    });

    it('sends no dApp header from a dApp page, where the browser sets the Origin', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify(QUOTES)))
        );

        await fetchTokenQuotes(`${JAW_PAYMASTER_URL}?chainId=8453`, 8453, ['0xabc']);

        expect(headersSent()['x-dapp-origin']).toBeUndefined();
    });

    it('reports the status when the proxy answers with an error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('{"statusCode":500,"message":"Internal server error"}', { status: 500 }))
        );

        await expect(fetchTokenQuotes(`${JAW_PAYMASTER_URL}?chainId=8453`, 8453, ['0xabc'])).rejects.toThrow(
            'pimlico_getTokenQuotes failed with 500: {"statusCode":500,"message":"Internal server error"}'
        );
    });
});

// Every request, from the quote to the bundler, goes through the stubbed fetch, so
// viem's own error mapping runs on what a bundler answers.
describe('estimateErc20PaymasterCosts failures', () => {
    const PAYMASTER_URL = 'https://paymaster.test';
    const chain = { id: 84532, rpcUrl: 'https://rpc.test' };
    const tokens: TokenInfo[] = [{ address: TOKEN, symbol: 'USDC', decimals: 6, balance: 0n }];
    const calls = [{ to: TOKEN }];

    const account = {
        address: '0x1111111111111111111111111111111111111111',
        entryPoint: { address: entryPoint08Address, abi: entryPoint08Abi, version: '0.8' },
        encodeCalls: async () => '0x',
        getFactoryArgs: async () => ({ factory: undefined, factoryData: undefined }),
        getNonce: async () => 0n,
        getStubSignature: async () => '0x',
    } as unknown as SmartAccount;

    const QUOTES = {
        quotes: [{ token: TOKEN, postOpGas: '0x4a38', exchangeRate: '0xde0b6b3a7640000', paymaster: PAYMASTER }],
    };

    const answers: Record<string, unknown> = {
        eth_chainId: '0x14a34',
        eth_maxPriorityFeePerGas: '0x1',
        eth_getBlockByNumber: {
            number: '0x1',
            hash: `0x${'11'.repeat(32)}`,
            timestamp: '0x1',
            baseFeePerGas: '0x1',
            transactions: [],
        },
        pm_getPaymasterStubData: {
            paymaster: PAYMASTER,
            paymasterData: '0x',
            paymasterVerificationGasLimit: '0x10000',
            paymasterPostOpGasLimit: '0x10000',
            isFinal: true,
        },
    };

    // `failing` (the bundler's estimation by default) answers with `bundler`; every
    // other method gets the canned answer above.
    function stubNetwork(
        bundler: { code: number; message: string } | 'down',
        quotes: unknown = QUOTES,
        failing = 'eth_estimateUserOperationGas'
    ) {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: string, init: { body: string }) => {
                const { id, method } = JSON.parse(init.body);
                if (method === 'pimlico_getTokenQuotes') {
                    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: quotes }));
                }
                if (method === failing) {
                    if (bundler === 'down') throw new TypeError('fetch failed');
                    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: bundler }));
                }
                return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: answers[method] }));
            })
        );
    }

    function estimate(options?: { permissionId?: Hex }) {
        return estimateErc20PaymasterCosts(account, calls, chain, PAYMASTER_URL, tokens, options);
    }

    async function failure(promise: Promise<unknown>): Promise<Erc20EstimationError> {
        const error = await promise.then(
            () => undefined,
            (e: unknown) => e
        );
        expect(error).toBeInstanceOf(Erc20EstimationError);
        return error as Erc20EstimationError;
    }

    afterEach(() => {
        vi.unstubAllGlobals();
        relayRequest.mockReset();
    });

    it('marks a quote the proxy refuses as the quote phase, keeping the original error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('Internal server error', { status: 500 }))
        );

        const error = await failure(estimate());

        expect(error.name).toBe('Erc20EstimationError');
        expect(error.phase).toBe('quote');
        expect(error.reason).toBe('unknown');
        expect(error.message).toBe('pimlico_getTokenQuotes failed with 500: Internal server error');
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as Error).message).toBe(error.message);
    });

    it('marks a JSON-RPC error on the quote as the quote phase', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad token' } })
                    )
            )
        );

        const error = await failure(estimate());

        expect(error.phase).toBe('quote');
        expect(error.message).toBe('pimlico_getTokenQuotes error: bad token');
    });

    it('marks an empty quote list as the quote phase', async () => {
        stubNetwork({ code: -32521, message: 'unused' }, { quotes: [] });

        const error = await failure(estimate());

        expect(error.phase).toBe('quote');
        expect(error.reason).toBe('unknown');
        expect(error.message).toBe('No token quotes returned from paymaster');
    });

    it('reads a call revert from the bundler code', async () => {
        stubNetwork({ code: -32521, message: 'execution reverted: 0x' });

        const error = await failure(estimate());

        expect(error.phase).toBe('userOp');
        expect(error.reason).toBe('call-reverted');
        expect(error.cause).toBeInstanceOf(Error);
        expect(error.message).toBe((error.cause as Error).message);
    });

    it('keeps a call revert whose reason says AA33 a call revert', async () => {
        stubNetwork({ code: -32521, message: 'execution reverted: AA33 reverted in the called contract' });

        const error = await failure(estimate());

        expect(error.phase).toBe('userOp');
        expect(error.reason).toBe('call-reverted');
    });

    it('reads a paymaster validation failure from the bundler code', async () => {
        stubNetwork({ code: -32501, message: 'AA33 reverted' });

        expect((await failure(estimate())).reason).toBe('paymaster-validation');
    });

    it('reads an account validation failure from the bundler code', async () => {
        stubNetwork({ code: -32500, message: 'AA23 reverted' });

        expect((await failure(estimate())).reason).toBe('account-validation');
    });

    it('gives no reason for a bundler code outside the three it maps', async () => {
        stubNetwork({ code: -32602, message: 'invalid params' });

        const error = await failure(estimate());

        expect(error.phase).toBe('userOp');
        expect(error.reason).toBe('unknown');
    });

    it('gives no reason when the paymaster, not the bundler, answers with a bundler code', async () => {
        stubNetwork({ code: -32500, message: 'AA23 reverted' }, QUOTES, 'pm_getPaymasterStubData');

        const error = await failure(estimate());

        expect(error.phase).toBe('userOp');
        expect(error.reason).toBe('unknown');
    });

    it('gives no reason when the bundler cannot be reached', async () => {
        stubNetwork('down');

        const error = await failure(estimate());

        expect(error.phase).toBe('userOp');
        expect(error.reason).toBe('unknown');
    }, 15_000);

    it('marks a failed permission lookup as the permission phase', async () => {
        stubNetwork({ code: -32521, message: 'unused' });
        relayRequest.mockRejectedValue(new Error('permission not found'));

        const error = await failure(estimate({ permissionId: `0x${'ab'.repeat(32)}` }));

        expect(error.phase).toBe('permission');
        expect(error.reason).toBe('unknown');
        expect(error.cause).toBeDefined();
    });
});

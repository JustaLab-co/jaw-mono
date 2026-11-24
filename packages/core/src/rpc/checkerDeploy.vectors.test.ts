/**
 * Golden vectors for the call checker a grant names and the deploy the grant batch
 * adds for it. Each `checker` was returned by the deployed CheckerFactory's own
 * `predict` on Base Sepolia, and each `deployCalldata` by `cast calldata`, so a
 * mistake in the clone's init code or the deploy encoding fails here. See
 * vectors/README.md for the commands.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { Address, Hex } from 'viem';

import { CHECKER_FACTORY_ADDRESS } from '../constants.js';
import { checkerDeployCalls, predictCheckerAddress } from './checkerDeploy.js';

type Vector = { description: string; template: Address; settings: Hex; checker: Address; deployCalldata: Hex };

const vectors: Vector[] = JSON.parse(
    readFileSync(new URL('../../vectors/checker-calls.json', import.meta.url), 'utf8')
);

describe('call checkers, against vectors from the deployed factory', () => {
    it.each(vectors)('predicts $description', ({ template, settings, checker }) => {
        expect(predictCheckerAddress(template, settings)).toBe(checker);
    });

    it.each(vectors)('deploys $description', ({ template, settings, checker, deployCalldata }) => {
        const calls = checkerDeployCalls({
            calls: [
                {
                    target: '0x3333333333333333333333333333333333333333',
                    checker,
                    checkerDeploy: { template, settings },
                },
            ],
        });
        expect(calls).toEqual([{ to: CHECKER_FACTORY_ADDRESS, data: deployCalldata }]);
    });
});

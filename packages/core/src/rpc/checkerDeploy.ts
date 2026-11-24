import { concat, encodeFunctionData, getAddress, getContractAddress, numberToHex, size, zeroHash } from 'viem';
import type { Address, Hex } from 'viem';

import { CHECKER_FACTORY_ADDRESS } from '../constants.js';
import { standardErrors } from '../errors/index.js';
import { isRecord, requireHexAddress, requireHexBytes } from './paramUtils.js';
import type { PermissionsDetail } from './permissions.js';

/**
 * How to deploy a call checker that may not exist yet: the template it clones and the
 * settings baked into the clone. The factory turns these into one fixed address, so a
 * grant can name the checker before it is deployed and deploy it in the same batch.
 */
export type CheckerDeploy = {
    /** The checker template the clone runs, e.g. `ARG_IN_TEMPLATE_ADDRESS`. */
    template: Address;
    /** The template's settings, ABI encoded. See the call-checkers README for each layout. */
    settings: Hex;
};

const GRANT_METHOD = 'wallet_grantPermissions';

/** Longest settings a clone can hold, the EIP-170 code size limit minus the 45-byte proxy. Mirrors `CheckerFactory.MAX_SETTINGS_LENGTH`. */
const MAX_SETTINGS_LENGTH = 24_531;

const CHECKER_FACTORY_ABI = [
    {
        type: 'function',
        name: 'deploy',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'template', type: 'address' },
            { name: 'settings', type: 'bytes' },
        ],
        outputs: [{ name: 'checker', type: 'address' }],
    },
] as const;

/**
 * Where `CheckerFactory` puts the checker for `template` with `settings`, deployed or
 * not. Matches `CheckerFactory.predict`: CREATE2 from the factory with a zero salt over
 * Solady's clone-with-immutable-args init code.
 */
export function predictCheckerAddress(template: Address, settings: Hex): Address {
    const initCode = concat([
        '0x61',
        numberToHex(0x2d + size(settings), { size: 2 }),
        '0x3d81600a3d39f3363d3d373d3d3d363d73',
        template,
        '0x5af43d82803e903d91602b57fd5bf3',
        settings,
    ]);
    return getContractAddress({ opcode: 'CREATE2', from: CHECKER_FACTORY_ADDRESS, salt: zeroHash, bytecode: initCode });
}

/**
 * A call's `checkerDeploy`, checked, with the checker it deploys. Refused when it is malformed or
 * would deploy a different contract from the call's `checker`: the user approves the checker
 * address, so a deploy that lands anywhere else leaves the permission naming a contract nobody
 * deployed. Undefined when the call has none.
 */
export function optionalCallCheckerDeploy(
    call: unknown,
    index: number
): (CheckerDeploy & { checker: Address }) | undefined {
    const { checker, checkerDeploy } = (isRecord(call) ? call : {}) as { checker?: unknown; checkerDeploy?: unknown };
    if (checkerDeploy === undefined || checkerDeploy === null) return undefined;

    const field = `permissions.calls[${index}].checkerDeploy`;
    if (!isRecord(checkerDeploy)) {
        throw standardErrors.rpc.invalidParams(
            `${GRANT_METHOD}: ${field} must be an object with template and settings`
        );
    }
    const template = requireHexAddress(checkerDeploy.template, GRANT_METHOD, `${field}.template`);
    const settings = requireHexBytes(checkerDeploy.settings, GRANT_METHOD, `${field}.settings`);
    if (size(settings) > MAX_SETTINGS_LENGTH) {
        throw standardErrors.rpc.invalidParams(
            `${GRANT_METHOD}: ${field}.settings is ${size(settings)} bytes, more than a checker can hold (${MAX_SETTINGS_LENGTH})`
        );
    }
    const predicted = predictCheckerAddress(template, settings);
    if (typeof checker !== 'string' || checker.toLowerCase() !== predicted.toLowerCase()) {
        throw standardErrors.rpc.invalidParams(
            `${GRANT_METHOD}: ${field} deploys ${predicted}, so permissions.calls[${index}].checker must be that address`
        );
    }
    return { template: getAddress(template), settings, checker: predicted };
}

/**
 * The `factory.deploy` calls a grant adds ahead of `approve`, one per distinct checker
 * that comes with a `checkerDeploy`. Added whether or not the checker exists yet: for
 * one that does, `deploy` returns it and costs about 3k gas, which saves a read per
 * checker before every grant.
 */
export function checkerDeployCalls(permissions: Pick<PermissionsDetail, 'calls'>): Array<{ to: Address; data: Hex }> {
    const seen = new Set<string>();
    const deploys: Array<{ to: Address; data: Hex }> = [];
    (permissions.calls ?? []).forEach((call, index) => {
        const deploy = optionalCallCheckerDeploy(call, index);
        if (!deploy || seen.has(deploy.checker)) return;
        seen.add(deploy.checker);
        deploys.push({
            to: CHECKER_FACTORY_ADDRESS,
            data: encodeFunctionData({
                abi: CHECKER_FACTORY_ABI,
                functionName: 'deploy',
                args: [deploy.template, deploy.settings],
            }),
        });
    });
    return deploys;
}

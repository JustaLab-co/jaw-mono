import { ANY_FN_SEL, ANY_TARGET, EMPTY_CALLDATA_FN_SEL, PERMISSIONS_MANAGER_ADDRESS } from '@jaw.id/core';
import { PERMISSION_MANAGER_ABI, type GrantedPermission, type ReadDeps } from '@jaw.id/agent';
import {
  ContractFunctionRevertedError,
  encodeErrorResult,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { ChainUnreadable, fit, refusalOfRevert, spendOf, type Call } from './fit';
import type { LiveGrant } from './store';

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const SESSION: Address = '0x5555555555555555555555555555555555555555';
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BOB: Address = '0x2222222222222222222222222222222222222222';
const CAROL: Address = '0x3333333333333333333333333333333333333333';
const NATIVE: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const PERMISSION_ID: Hex = `0x${'d'.repeat(64)}`;
const TRANSFER = toFunctionSelector('transfer(address,uint256)');
const NOW = 1_800_000_000;

const transfer = (to: Address, amount: bigint, token = USDC): Call => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
});

function grantOf(p: Partial<GrantedPermission> = {}): LiveGrant {
  return {
    permissionId: PERMISSION_ID,
    kind: 'custom',
    chainId: 84532,
    account: ACCOUNT,
    spender: SESSION,
    permission: {
      account: ACCOUNT,
      spender: SESSION,
      start: NOW - 3600,
      end: NOW + 86_400,
      salt: '0x01',
      calls: [{ target: USDC, selector: TRANSFER }],
      spends: [{ token: USDC, allowance: '1000000', unit: 'day', multiplier: 1 }],
      ...p,
    },
    expiresAt: new Date((NOW + 86_400) * 1000),
    createdAt: new Date((NOW - 3600) * 1000),
  };
}

interface FakeChain {
  revoked?: boolean;
  down?: boolean;
  ended?: boolean;
  spent?: Record<string, bigint>;
}

/** The permission manager as the chain answers it: the permission approved, each limit's counter in `spent`. */
function chain(c: FakeChain = {}): ReadDeps {
  return {
    manager: PERMISSIONS_MANAGER_ADDRESS,
    readContract: async ({ functionName, args }) => {
      if (c.down) throw new Error('node down');
      if (functionName === 'getHash') return PERMISSION_ID;
      if (functionName === 'isApproved') return true;
      if (functionName === 'isRevoked') return c.revoked ?? false;
      if (c.ended) {
        throw new ContractFunctionRevertedError({
          abi: PERMISSION_MANAGER_ABI,
          functionName: 'getCurrentPeriod',
          data: encodeErrorResult({
            abi: PERMISSION_MANAGER_ABI,
            errorName: 'JustaPermissionManager_AfterPermissionEnd',
            args: [NOW, NOW - 1],
          }),
        });
      }
      const token = (args[1] as { token: Address }).token.toLowerCase();
      return { start: NOW - 3600, end: NOW + 82_800, spend: c.spent?.[token] ?? 0n };
    },
  };
}

const at = (read: ReadDeps, pending = new Map<string, bigint>()) => ({ read, pending, nowSeconds: NOW });

describe('fit', () => {
  it('passes a transfer the grant allows within what the limit has left', async () => {
    expect(
      await fit(grantOf(), [transfer(BOB, 400_000n)], at(chain({ spent: { [USDC.toLowerCase()]: 600_000n } })))
    ).toBe(undefined);
  });

  it('refuses a call to a target the grant does not name as call-not-allowed, before any chain read', async () => {
    const other = { ...transfer(BOB, 1n), to: CAROL };
    expect(await fit(grantOf(), [transfer(BOB, 1n), other], at(chain({ down: true })))).toEqual({
      reason: 'call-not-allowed',
      target: CAROL,
      selector: TRANSFER,
    });
  });

  it('refuses another function on an allowed target as call-not-allowed', async () => {
    const approve: Call = {
      to: USDC,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [BOB, 1n] }),
    };
    expect(await fit(grantOf(), [approve], at(chain()))).toMatchObject({
      reason: 'call-not-allowed',
      selector: toFunctionSelector('approve(address,uint256)'),
    });
  });

  it('lets ANY_TARGET stand for every target with the named function', async () => {
    const grant = grantOf({
      calls: [{ target: ANY_TARGET, selector: TRANSFER }],
      spends: [
        { token: USDC, allowance: '10', unit: 'day', multiplier: 1 },
        { token: CAROL, allowance: '10', unit: 'day', multiplier: 1 },
      ],
    });
    expect(await fit(grant, [transfer(BOB, 5n, CAROL)], at(chain()))).toBe(undefined);
  });

  it('lets ANY_FN_SEL stand for every function of the target, empty calldata included', async () => {
    const grant = grantOf({ calls: [{ target: BOB, selector: ANY_FN_SEL }], spends: [] });
    const calls: Call[] = [
      { to: BOB, value: 0n, data: '0x12345678' },
      { to: BOB, value: 0n, data: '0x' },
    ];
    expect(await fit(grant, calls, at(chain()))).toBe(undefined);
  });

  it('matches a plain coin transfer only through the empty-calldata selector', async () => {
    const send: Call = { to: BOB, value: 5n, data: '0x' };
    const withEmpty = grantOf({
      calls: [{ target: BOB, selector: EMPTY_CALLDATA_FN_SEL }],
      spends: [{ token: NATIVE, allowance: '10', unit: 'day', multiplier: 1 }],
    });
    expect(await fit(withEmpty, [send], at(chain()))).toBe(undefined);
    const withTransfer = grantOf({ calls: [{ target: BOB, selector: TRANSFER }] });
    expect(await fit(withTransfer, [send], at(chain()))).toMatchObject({ reason: 'call-not-allowed' });
  });

  it('refuses the account and the permission manager as targets even under ANY_TARGET', async () => {
    const grant = grantOf({ calls: [{ target: ANY_TARGET, selector: ANY_FN_SEL }] });
    for (const to of [ACCOUNT, PERMISSIONS_MANAGER_ADDRESS as Address]) {
      expect(await fit(grant, [{ to, value: 0n, data: '0x' }], at(chain()))).toMatchObject({
        reason: 'call-not-allowed',
      });
    }
  });

  it('refuses a batch past what the period has left as over-limit, naming the token and what is left', async () => {
    const read = chain({ spent: { [USDC.toLowerCase()]: 700_000n } });
    expect(await fit(grantOf(), [transfer(BOB, 200_000n), transfer(CAROL, 200_000n)], at(read))).toEqual({
      reason: 'over-limit',
      token: USDC,
      spend: 400_000n,
      left: 300_000n,
    });
  });

  it('counts what open sends under the grant still hold as spent', async () => {
    const pending = new Map([[USDC.toLowerCase(), 700_000n]]);
    expect(await fit(grantOf(), [transfer(BOB, 400_000n)], at(chain(), pending))).toMatchObject({
      reason: 'over-limit',
      left: 300_000n,
    });
  });

  it('refuses a token the grant sets no limit on as over-limit with nothing left', async () => {
    const grant = grantOf({ calls: [{ target: BOB, selector: EMPTY_CALLDATA_FN_SEL }] });
    expect(await fit(grant, [{ to: BOB, value: 1n, data: '0x' }], at(chain()))).toEqual({
      reason: 'over-limit',
      token: NATIVE,
      spend: 1n,
      left: 0n,
    });
  });

  it('refuses a grant past its end as expired without reading the chain', async () => {
    expect(await fit(grantOf({ end: NOW - 1 }), [transfer(BOB, 1n)], at(chain({ down: true })))).toEqual({
      reason: 'expired',
    });
  });

  it('refuses as expired when the chain says the permission is outside its window', async () => {
    expect(await fit(grantOf(), [transfer(BOB, 1n)], at(chain({ ended: true })))).toEqual({ reason: 'expired' });
  });

  it('refuses a grant revoked on chain as no-grant', async () => {
    expect(await fit(grantOf(), [transfer(BOB, 1n)], at(chain({ revoked: true })))).toEqual({ reason: 'no-grant' });
  });

  it('throws rather than refuse or pass when the chain does not answer', async () => {
    await expect(fit(grantOf(), [transfer(BOB, 1n)], at(chain({ down: true })))).rejects.toThrow(ChainUnreadable);
  });
});

describe('spendOf', () => {
  it('sums coin value and the token operations the manager counts, by token', () => {
    const pull: Call = {
      to: USDC,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [ACCOUNT, BOB, 3n] }),
    };
    const pullFromOther = {
      ...pull,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [CAROL, BOB, 9n] }),
    };
    const spent = spendOf([transfer(BOB, 2n), pull, pullFromOther, { to: BOB, value: 7n, data: '0x' }], ACCOUNT);
    expect(spent).toEqual(
      new Map([
        [USDC.toLowerCase(), 5n],
        [NATIVE.toLowerCase(), 7n],
      ])
    );
  });

  it('counts calldata written in upper case hex the same', () => {
    const upper = transfer(BOB, 2n);
    upper.data = `0x${upper.data.slice(2).toUpperCase()}`;
    expect(spendOf([upper], ACCOUNT)).toEqual(new Map([[USDC.toLowerCase(), 2n]]));
  });
});

const MANAGER_ERRORS = parseAbi([
  'error JustaPermissionManager_UnauthorizedCall(address target, bytes4 selector)',
  'error JustaPermissionManager_ExceededSpendLimit(uint256 value, uint256 allowance)',
  'error JustaPermissionManager_AfterPermissionEnd(uint48 currentTimestamp, uint48 end)',
]);

describe('refusalOfRevert', () => {
  it('names an ExceededSpendLimit the bundler reports in simulation as over-limit', () => {
    const data = encodeErrorResult({
      abi: MANAGER_ERRORS,
      errorName: 'JustaPermissionManager_ExceededSpendLimit',
      args: [2_000_000n, 1_000_000n],
    });
    const err = new Error('Could not size the ERC-20 paymaster approval', {
      cause: { message: `UserOperation reverted during simulation with reason: ${data}` },
    });
    expect(refusalOfRevert(err)).toEqual({ reason: 'over-limit' });
  });

  it('names an UnauthorizedCall wrapped in a revert of the account as call-not-allowed', () => {
    const inner = encodeErrorResult({
      abi: MANAGER_ERRORS,
      errorName: 'JustaPermissionManager_UnauthorizedCall',
      args: [CAROL, TRANSFER],
    });
    const wrapped = encodeErrorResult({
      abi: parseAbi(['error ExecutionFailed(bytes reason)']),
      errorName: 'ExecutionFailed',
      args: [inner],
    });
    expect(refusalOfRevert(wrapped)).toEqual({ reason: 'call-not-allowed', target: CAROL, selector: TRANSFER });
  });

  it('names an AfterPermissionEnd as expired', () => {
    const data = encodeErrorResult({
      abi: MANAGER_ERRORS,
      errorName: 'JustaPermissionManager_AfterPermissionEnd',
      args: [NOW, NOW - 1],
    });
    expect(refusalOfRevert({ details: `execution reverted: ${data}` })).toEqual({ reason: 'expired' });
  });

  it('names nothing in a failure that carries no manager error', () => {
    expect(refusalOfRevert(new Error("AA21 didn't pay prefund 0xdeadbeefcafe"))).toBe(undefined);
  });
});

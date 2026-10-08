import { describe, it, expect, vi } from 'vitest';
import {
  encodeErrorResult,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  ContractFunctionRevertedError,
  zeroAddress,
} from 'viem';
import {
  PERMISSION_MANAGER_ABI,
  toContractPermission,
  readPermissionState,
  readCurrentPeriods,
} from './permission-onchain.js';
import type { GrantedPermission } from '../session/session-config.js';

const MANAGER = '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8' as const;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const PERMISSION_ID = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

const GRANTED: GrantedPermission = {
  account: '0x1111111111111111111111111111111111111111',
  spender: '0x2222222222222222222222222222222222222222',
  start: 1_756_000_000,
  end: 1_756_604_800,
  salt: '0xabc123',
  calls: [{ target: USDC, selector: '0xa9059cbb' }],
  spends: [{ token: USDC, allowance: '0x4c4b40', unit: 'day', multiplier: 1 }],
};

const target = { chainId: 84532, permissionId: PERMISSION_ID, permission: GRANTED };

// Converted once, and asserted here rather than with a non-null at each use:
// a fixture that stopped converting would otherwise fail as an unrelated
// encoding error further down.
const CONTRACT_PERMISSION = toContractPermission(GRANTED);
if (!CONTRACT_PERMISSION) throw new Error('the fixture permission must convert');

/**
 * The struct is not decorative: the manager hashes what it is handed, so a
 * field in the wrong order or at the wrong width produces a hash for a
 * permission that was never granted, and every read returns a confident answer
 * about it. These signatures are the ones in
 * `contracts/permissions/src/JustaPermissionManager.sol`, written out by hand
 * so a change on either side has to be made deliberately on both.
 */
const PERMISSION_TUPLE =
  '(address,address,uint48,uint48,uint256,(address,bytes4,address)[],(address,uint160,uint8,uint16)[])';
const SPEND_LIMIT_TUPLE = '(address,uint160,uint8,uint16)';

describe('the permission struct as the contract hashes it', () => {
  it.each([
    ['getHash', `getHash(${PERMISSION_TUPLE})`],
    ['isApproved', `isApproved(${PERMISSION_TUPLE})`],
    ['isRevoked', `isRevoked(${PERMISSION_TUPLE})`],
  ] as const)('%s encodes the signature the contract declares', (functionName, signature) => {
    const calldata = encodeFunctionData({
      abi: PERMISSION_MANAGER_ABI,
      functionName,
      args: [CONTRACT_PERMISSION],
    });
    expect(calldata.slice(0, 10)).toBe(toFunctionSelector(signature));
  });

  it('getCurrentPeriod encodes the signature the contract declares', () => {
    const calldata = encodeFunctionData({
      abi: PERMISSION_MANAGER_ABI,
      functionName: 'getCurrentPeriod',
      args: [CONTRACT_PERMISSION, CONTRACT_PERMISSION.spends[0]],
    });
    expect(calldata.slice(0, 10)).toBe(
      toFunctionSelector(`getCurrentPeriod(${PERMISSION_TUPLE},${SPEND_LIMIT_TUPLE})`)
    );
  });

  it('fills the checker with the zero address, the way the grant encoded it', () => {
    expect(toContractPermission(GRANTED)?.calls[0]).toEqual({
      target: USDC,
      selector: '0xa9059cbb',
      checker: zeroAddress,
    });
  });

  it('widens the hex salt and allowance the response carries', () => {
    const converted = toContractPermission(GRANTED);
    expect(converted?.salt).toBe(0xabc123n);
    expect(converted?.spends[0].allowance).toBe(5_000_000n);
  });

  it('maps the period unit to the contract enum', () => {
    const units = ['minute', 'hour', 'day', 'week', 'month', 'forever'];
    const enums = units.map(
      (unit) => toContractPermission({ ...GRANTED, spends: [{ ...GRANTED.spends[0], unit }] })?.spends[0].unit
    );
    expect(enums).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // The SDK does this before encoding, so a yearly grant was hashed this way.
  // Rebuilding it as a `year` unit would hash to nothing that exists.
  it('rewrites a yearly spend to months, as the grant did', () => {
    const yearly = toContractPermission({
      ...GRANTED,
      spends: [{ ...GRANTED.spends[0], unit: 'year', multiplier: 2 }],
    });
    expect(yearly?.spends[0]).toMatchObject({ unit: 4, multiplier: 24 });
  });

  it('refuses a unit with no on-chain meaning rather than guessing one', () => {
    expect(toContractPermission({ ...GRANTED, spends: [{ ...GRANTED.spends[0], unit: 'fortnight' }] })).toBeNull();
  });
});

describe('readPermissionState', () => {
  it('reports approval and revocation when the hash matches the granted id', async () => {
    const state = await readPermissionState(target, {
      manager: MANAGER,
      readContract: async ({ functionName }) =>
        functionName === 'getHash' ? PERMISSION_ID : functionName === 'isRevoked',
    });
    expect(state).toEqual({ status: 'ok', approved: false, revoked: true });
  });

  it('matches the id case-insensitively', async () => {
    const state = await readPermissionState(
      { ...target, permissionId: PERMISSION_ID.toUpperCase().replace('0X', '0x') },
      {
        manager: MANAGER,
        readContract: async ({ functionName }) => (functionName === 'getHash' ? PERMISSION_ID : true),
      }
    );
    expect(state).toMatchObject({ status: 'ok' });
  });

  /**
   * The case the zero-address checker assumption breaks in. Answering `ok` here
   * would report on whatever permission the rebuilt struct happens to hash to.
   */
  it('reports a mismatch when the struct hashes to a different permission', async () => {
    const state = await readPermissionState(target, {
      manager: MANAGER,
      readContract: async ({ functionName }) => (functionName === 'getHash' ? '0xdeadbeef' : true),
    });
    expect(state).toEqual({ status: 'mismatch' });
  });

  it('cannot tell when the node does not answer', async () => {
    const state = await readPermissionState(target, {
      manager: MANAGER,
      readContract: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(state).toEqual({ status: 'unavailable' });
  });

  it('cannot tell for a session that carries no struct', async () => {
    const read = vi.fn();
    const state = await readPermissionState({ chainId: 84532, permissionId: PERMISSION_ID }, { readContract: read });
    expect(state).toEqual({ status: 'unavailable' });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('readCurrentPeriods', () => {
  const period = { start: 1_756_000_000, end: 1_756_086_400, spend: 5_000_000n };
  const answering = async ({ functionName }: { functionName: string }) =>
    functionName === 'getHash' ? PERMISSION_ID : period;

  it('returns the window and the spend the allowance actually lost', async () => {
    const result = await readCurrentPeriods({ ...target, token: USDC }, { manager: MANAGER, readContract: answering });
    expect(result).toEqual([{ ...GRANTED.spends[0], period: { status: 'ok', ...period } }]);
  });

  /**
   * The reason this is plural. The contract keeps a counter per limit, so a
   * permission with several on one token has several budgets, and reading one
   * answers about one of them. They go in a single batch, so N limits cost one
   * round trip.
   */
  it('reads every limit on the token, in one batch', async () => {
    const two = {
      ...GRANTED,
      spends: [
        { token: USDC, allowance: '50000000', unit: 'day', multiplier: 1 },
        { token: USDC, allowance: '100000000', unit: 'month', multiplier: 1 },
      ],
    };
    let calls = 0;
    const result = await readCurrentPeriods(
      { ...target, permission: two, token: USDC },
      {
        manager: MANAGER,
        readContract: async ({ functionName }) => {
          calls += 1;
          return functionName === 'getHash' ? PERMISSION_ID : period;
        },
      }
    );
    expect(result.map((r) => r.allowance)).toEqual(['50000000', '100000000']);
    expect(calls).toBe(3); // one hash plus one counter each
  });

  /**
   * `getCurrentPeriod` does not require the permission to exist. Handed a
   * struct that hashes to something else it answers about that other hash, as
   * a zeroed counter over a window built from the on-disk start.
   */
  it('cannot tell when the struct hashes to a different permission', async () => {
    const result = await readCurrentPeriods(
      { ...target, token: USDC },
      { manager: MANAGER, readContract: async ({ functionName }) => (functionName === 'getHash' ? '0xother' : period) }
    );
    expect(result.map((r) => r.period.status)).toEqual(['unavailable']);
  });

  it('reads a time-bound revert as being outside the window', async () => {
    const errorAbi = parseAbi(['error JustaPermissionManager_AfterPermissionEnd(uint48 currentTimestamp, uint48 end)']);
    const reverted = new ContractFunctionRevertedError({
      abi: errorAbi,
      data: encodeErrorResult({
        abi: errorAbi,
        errorName: 'JustaPermissionManager_AfterPermissionEnd',
        args: [1_756_700_000, 1_756_604_800],
      }),
      functionName: 'getCurrentPeriod',
    });
    const result = await readCurrentPeriods(
      { ...target, token: USDC },
      {
        manager: MANAGER,
        readContract: async ({ functionName }) => {
          if (functionName === 'getHash') return PERMISSION_ID;
          throw reverted;
        },
      }
    );
    expect(result.map((r) => r.period.status)).toEqual(['outside-window']);
  });

  it('reads any other failure as not knowing', async () => {
    const result = await readCurrentPeriods(
      { ...target, token: USDC },
      {
        manager: MANAGER,
        readContract: async ({ functionName }) => {
          if (functionName === 'getHash') return PERMISSION_ID;
          throw new Error('fetch failed');
        },
      }
    );
    expect(result.map((r) => r.period.status)).toEqual(['unavailable']);
  });

  it('returns nothing for a token the permission carries no limit for', async () => {
    const read = vi.fn();
    const result = await readCurrentPeriods(
      { ...target, token: '0x9999999999999999999999999999999999999999' },
      { manager: MANAGER, readContract: read }
    );
    expect(result).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

/**
 * These reads sit in commands that were local before them. viem retries three
 * times at ten seconds, so an unreachable node would hold a status report open
 * for most of a minute to add a fact every caller treats as optional.
 */
describe('a node that does not answer', () => {
  it('gives up and reports not knowing', async () => {
    const never = () => new Promise<never>(() => undefined);
    await expect(readPermissionState(target, { manager: MANAGER, readContract: never, timeoutMs: 5 })).resolves.toEqual(
      { status: 'unavailable' }
    );
    await expect(
      readCurrentPeriods({ ...target, token: USDC }, { manager: MANAGER, readContract: never, timeoutMs: 5 })
    ).resolves.toEqual([{ ...GRANTED.spends[0], period: { status: 'unavailable' } }]);
  });
});

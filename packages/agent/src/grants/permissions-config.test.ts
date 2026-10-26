import { describe, it, expect } from 'vitest';
import { parsePermissionsConfig, PERMISSIONS_MANAGER } from './permissions-config.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHECKER = '0x398b9d939E7E616E03eA99601c835C920621B2ca';

const withChecker = (checker: unknown) => ({
  calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)', checker }],
});

/**
 * A checker is part of the permission the owner approves, so a config naming one that can never
 * be granted fails here, before a browser opens, rather than at the grant screen.
 */
describe('a call checker in a permissions config', () => {
  it('is kept as given', () => {
    expect(parsePermissionsConfig(withChecker(CHECKER)).calls?.[0].checker).toBe(CHECKER);
  });

  it.each([
    ['a truncated address', '0x8888'],
    ['a non-string', 42],
  ])('is refused when it is %s', (_label, checker) => {
    expect(() => parsePermissionsConfig(withChecker(checker))).toThrow(/calls\.0\.checker/);
  });

  // The manager refuses itself as a checker when the permission is approved.
  it('is refused when it is the permission manager', () => {
    expect(() => parsePermissionsConfig(withChecker(PERMISSIONS_MANAGER.toLowerCase()))).toThrow(
      /calls\.0\.checker.*permission manager/
    );
  });

  // Lazy, as every core import in this package has to be. Loading the whole SDK can pass five
  // seconds when the suite runs beside the rest of the workspace, so this one gets longer.
  it('names the same permission manager as the SDK', { timeout: 30_000 }, async () => {
    const { PERMISSIONS_MANAGER_ADDRESS } = await import('@jaw.id/core');
    expect(PERMISSIONS_MANAGER.toLowerCase()).toBe(PERMISSIONS_MANAGER_ADDRESS.toLowerCase());
  });
});

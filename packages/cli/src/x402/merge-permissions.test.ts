import { describe, it, expect } from 'vitest';
import { mergePermissions, describeMerge } from './merge-permissions.js';
import { buildX402Permissions } from './grant-preset.js';
import type { GrantedPermission } from '../lib/session-config.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NFT = '0x4444444444444444444444444444444444444444';
const TRANSFER = '0xa9059cbb';
const MINT = '0x1249c58b';

/**
 * The scope an agent is already working under. Only knowable because the
 * granted permission is stored the way the contract holds it: a permission id
 * says nothing about what it allows.
 */
const EXISTING: GrantedPermission = {
  account: '0x1111111111111111111111111111111111111111',
  spender: '0x2222222222222222222222222222222222222222',
  start: 1_756_000_000,
  end: 1_756_604_800,
  salt: '0xabc',
  calls: [{ target: NFT, selector: MINT }],
  spends: [],
};

describe('mergePermissions', () => {
  /**
   * The case the whole command exists for: an agent with a scoped session
   * discovers it needs to pay. Re-running setup would revoke the grant it is
   * working under and it would lose the mint mid-task.
   */
  it('adds payments without dropping what the session already allows', () => {
    const merged = mergePermissions(EXISTING, buildX402Permissions(84532, '10/day'));

    expect(merged.calls).toEqual([
      { target: NFT, selector: MINT },
      { target: USDC, functionSignature: 'transfer(address,uint256)' },
    ]);
    expect(merged.spends).toEqual([{ token: USDC, allowance: '10000000', unit: 'day', multiplier: 1 }]);
  });

  it('keeps a call the session already has rather than listing it twice', () => {
    const merged = mergePermissions(EXISTING, { calls: [{ target: NFT, selector: MINT }] });
    expect(merged.calls).toEqual([{ target: NFT, selector: MINT }]);
  });

  it('matches a call case-insensitively, the way an address compares', () => {
    const merged = mergePermissions(EXISTING, { calls: [{ target: NFT.toUpperCase(), selector: MINT }] });
    expect(merged.calls).toHaveLength(1);
  });

  /**
   * `add x402 --limit 10/day` over a session already allowing 5/day reads as
   * asking for 10, not 15. Keeping both entries would grant 15 more quietly,
   * since the contract meters each SpendLimit on its own counter.
   */
  it('replaces the allowance for a token it already meters', () => {
    const existing: GrantedPermission = {
      ...EXISTING,
      calls: [{ target: USDC, selector: TRANSFER }],
      spends: [{ token: USDC, allowance: '5000000', unit: 'day', multiplier: 1 }],
    };
    const merged = mergePermissions(existing, buildX402Permissions(84532, '10/day'));
    expect(merged.spends).toEqual([{ token: USDC, allowance: '10000000', unit: 'day', multiplier: 1 }]);
  });

  /**
   * Only the same window is superseded. Keying on the token alone dropped caps
   * the request never mentioned: a session holding a monthly budget and a daily
   * one, taking `add --x402` with no `--limit`, lost both to the preset's
   * default, from a command whose promise is to add without taking away.
   */
  it('keeps a limit on the same token over a different window', () => {
    const existing: GrantedPermission = {
      ...EXISTING,
      spends: [{ token: USDC, allowance: '1000000', unit: 'week', multiplier: 1 }],
    };
    const merged = mergePermissions(existing, buildX402Permissions(84532, '10/day'));
    expect(merged.spends).toEqual([
      { token: USDC, allowance: '1000000', unit: 'week', multiplier: 1 },
      { token: USDC, allowance: '10000000', unit: 'day', multiplier: 1 },
    ]);
  });

  it('leaves a limit on a token the addition does not name', () => {
    const other = '0x7777777777777777777777777777777777777777';
    const existing: GrantedPermission = {
      ...EXISTING,
      spends: [{ token: other, allowance: '1000000', unit: 'week', multiplier: 1 }],
    };
    const merged = mergePermissions(existing, buildX402Permissions(84532, '10/day'));
    expect(merged.spends).toHaveLength(2);
  });

  it('normalises the hex allowance the grant response carries', () => {
    const existing: GrantedPermission = {
      ...EXISTING,
      spends: [{ token: USDC, allowance: '0x4c4b40', unit: 'day', multiplier: 1 }],
    };
    expect(mergePermissions(existing, {}).spends).toEqual([
      { token: USDC, allowance: '5000000', unit: 'day', multiplier: 1 },
    ]);
  });
});

describe('describeMerge', () => {
  it('names what is being added, so the summary is not a diff of the whole scope', () => {
    const merged = mergePermissions(EXISTING, buildX402Permissions(84532, '10/day'));
    const lines = describeMerge(EXISTING, merged).join('\n');
    expect(lines).toMatch(/\+ call\s+0x036CbD/);
    expect(lines).toMatch(/\+ spend\s+10000000 of 0x036CbD/);
    expect(lines).not.toMatch(new RegExp(MINT));
  });

  it('shows a raised allowance as a change rather than an addition', () => {
    const existing: GrantedPermission = {
      ...EXISTING,
      calls: [{ target: USDC, selector: TRANSFER }],
      spends: [{ token: USDC, allowance: '5000000', unit: 'day', multiplier: 1 }],
    };
    const lines = describeMerge(existing, mergePermissions(existing, buildX402Permissions(84532, '10/day'))).join('\n');
    expect(lines).toMatch(/~ spend .*per day: 5000000 to 10000000/);
  });

  // What `session add` checks to decide there is nothing to do.
  it('is empty when the session already allows all of it', () => {
    const merged = mergePermissions(EXISTING, { calls: [{ target: NFT, selector: MINT }] });
    expect(describeMerge(EXISTING, merged)).toEqual([]);
  });

  /**
   * The preset names the call by signature and the stored permission by
   * selector, so nothing matched and `add --x402` was never a no-op: every run
   * re-granted, cost two browser approvals, and left another copy of the same
   * call on the permission.
   */
  it('matches a call named by signature against one already granted by selector', () => {
    const existing: GrantedPermission = {
      ...EXISTING,
      calls: [{ target: USDC, selector: TRANSFER }],
      spends: [{ token: USDC, allowance: '10000000', unit: 'day', multiplier: 1 }],
    };
    const merged = mergePermissions(existing, buildX402Permissions(84532, '10/day'));
    expect(merged.calls).toHaveLength(1);
    expect(describeMerge(existing, merged)).toEqual([]);
  });

  /**
   * `parsePermissionsConfig` rejects a defined-but-empty `spends`, so emitting
   * one for a calls-only session merged with a calls-only addition throws after
   * the browser is open.
   */
  it('leaves an empty spends out rather than sending an empty array', () => {
    const merged = mergePermissions(EXISTING, { calls: [{ target: NFT, selector: '0xdeadbeef' }] });
    expect(merged.spends).toBeUndefined();
    expect(merged.calls).toHaveLength(2);
  });

  /**
   * Every limit on a token is charged, so a new 10-a-day beside an untouched
   * 1-a-week leaves the session unable to move more than 1 a week. A summary
   * that listed only the addition would read as a raise that is not going to
   * happen.
   */
  it('names the other limits on the token that still apply', () => {
    const existing: GrantedPermission = {
      ...EXISTING,
      spends: [{ token: USDC, allowance: '1000000', unit: 'week', multiplier: 1 }],
    };
    const lines = describeMerge(existing, mergePermissions(existing, buildX402Permissions(84532, '10/day'))).join('\n');
    expect(lines).toMatch(/\+ spend\s+10000000/);
    expect(lines).toMatch(/! note\s+1000000 per week on the same token still applies/);
  });

  /**
   * A lifetime total is the case a rate comparison kept silent about: it is not
   * a rate, so ranking it against a daily limit meant ordering something that
   * has no order. It still applies, and that is what the note says.
   */
  it('names a lifetime total the same way', () => {
    const existing: GrantedPermission = {
      ...EXISTING,
      spends: [{ token: USDC, allowance: '50000000', unit: 'forever', multiplier: 1 }],
    };
    const lines = describeMerge(existing, mergePermissions(existing, buildX402Permissions(84532, '10/day'))).join('\n');
    expect(lines).toMatch(/! note\s+50000000 per forever on the same token still applies/);
  });

  it('says nothing extra when the addition supersedes the only limit there was', () => {
    const existing: GrantedPermission = {
      ...EXISTING,
      spends: [{ token: USDC, allowance: '5000000', unit: 'day', multiplier: 1 }],
    };
    const lines = describeMerge(existing, mergePermissions(existing, buildX402Permissions(84532, '10/day'))).join('\n');
    expect(lines).not.toMatch(/! note/);
  });
});

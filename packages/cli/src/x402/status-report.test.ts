import { describe, it, expect } from 'vitest';
import { formatUsdc, formatRemaining, diagnose, type StatusFacts } from './status-report.js';

describe('formatUsdc', () => {
  it('scales base units and trims trailing zeros', () => {
    expect(formatUsdc('10000000', 6)).toBe('10 USDC');
    expect(formatUsdc('2500000', 6)).toBe('2.5 USDC');
    expect(formatUsdc('1000', 6)).toBe('0.001 USDC');
    expect(formatUsdc('0', 6)).toBe('0 USDC');
  });

  it('reads an absent cap as unlimited rather than zero', () => {
    expect(formatUsdc(undefined, 6)).toBe('unlimited');
  });

  it('surfaces a malformed cap instead of rendering a wrong number', () => {
    expect(formatUsdc('not-a-number', 6)).toBe('not-a-number (invalid)');
  });

  // Amounts reach here from the ledger and from config, both editable files,
  // and the invalid branch used to echo whatever it was handed.
  it('disarms a malformed cap rather than printing it back raw', () => {
    const ESC = String.fromCharCode(0x1b);
    const out = formatUsdc(`9${ESC}[2K${ESC}[32m FAKE`, 6);
    expect(out).not.toContain(ESC);
    expect(out).toContain('(invalid)');
  });

  it('bounds a very long malformed cap', () => {
    expect(formatUsdc('9'.repeat(500), 6)).not.toContain('(invalid)');
  });
});

describe('formatRemaining', () => {
  it('counts whole days, falling back to hours under a day', () => {
    expect(formatRemaining(4 * 86400)).toBe('4 days left');
    expect(formatRemaining(86400)).toBe('1 day left');
    expect(formatRemaining(5 * 3600)).toBe('5h left');
    expect(formatRemaining(-10)).toBe('0h left');
  });
});

describe('diagnose', () => {
  const healthy: StatusFacts = {
    expired: false,
    ownerAddress: '0xOwner',
    ownerBalance: '12.5',
    payerBalance: '0',
    hasAsset: true,
    spent: 3_000_000n,
    sessionCap: 10_000_000n,
  };

  it('says nothing when the setup is fine', () => {
    expect(diagnose(healthy)).toEqual([]);
  });

  it('flags an expired session first', () => {
    expect(diagnose({ ...healthy, expired: true })[0]).toMatch(/session expired/i);
  });

  /**
   * The only fact here that has to come from the chain. Expiry is the same
   * number the session config carries, so a revoke made from keys.jaw.id or
   * from another machine was invisible: the file still said the session was
   * good for days.
   */
  it('flags a permission revoked on chain, with the local expiry still ahead', () => {
    const problems = diagnose({ ...healthy, liveness: 'revoked' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/revoked on chain/i);
  });

  // Also what a lagging node says seconds after a grant, so the message offers
  // that before telling anyone to re-run setup.
  it('flags a permission the chain has no approval for', () => {
    expect(diagnose({ ...healthy, liveness: 'unapproved' })[0]).toMatch(/no record of this permission/);
  });

  /**
   * A mismatch says the struct on disk does not hash to the granted id, so the
   * chain cannot be asked about this permission. Nothing about the permission
   * is wrong: the caps still apply and payments still go through. Counting it
   * as a problem flipped `ready` to false and stopped agents paying against a
   * healthy session over a local serialisation issue.
   */
  it('does not treat a struct that fails to hash as a reason to stop paying', () => {
    expect(diagnose({ ...healthy, liveness: 'mismatch' })).toEqual([]);
  });

  /**
   * Not knowing is not evidence. An unreachable node, a chain with no client
   * and a session written before the struct was stored all arrive as
   * `unknown`, and none of them may turn a working setup into a warning.
   */
  it.each(['unknown', 'active'] as const)('says nothing for %s', (liveness) => {
    expect(diagnose({ ...healthy, liveness })).toEqual([]);
  });

  it('says nothing when the field is absent, as it is for every older session', () => {
    expect(diagnose(healthy)).toEqual([]);
  });

  // Auto mode refuses these, so a report that stayed quiet would call a setup
  // ready when no payment can go through.
  it('flags a session an older CLI created', () => {
    const problems = diagnose({ ...healthy, outdated: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/older CLI and cannot pay/);
  });

  // The case worth having this command for: payments succeed, so nothing looks
  // wrong, but they spend the payer's own balance and never touch the permission.
  it('catches a funded payer next to an empty owner', () => {
    const problems = diagnose({ ...healthy, ownerBalance: '0', payerBalance: '16.98' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/bypass the permission/);
    expect(problems[0]).toMatch(/Move the funds to the owner/);
  });

  it('says there is nothing to pay with when both are empty', () => {
    const problems = diagnose({ ...healthy, ownerBalance: '0', payerBalance: '0' });
    expect(problems[0]).toMatch(/nothing to pay with/);
    expect(problems[0]).not.toMatch(/bypass/);
  });

  // Refills leave the reserve in the payer on purpose, to pay userOp fees with.
  // Reading it back as misdirected funds would tell the user to move money the
  // CLI put there itself.
  it('does not call the gas reserve misdirected funds', () => {
    const problems = diagnose({ ...healthy, ownerBalance: '0', payerBalance: '0.1', payerReserve: 0.1 });
    expect(problems[0]).toMatch(/nothing to pay with/);
    expect(problems[0]).not.toMatch(/bypass/);
  });

  it('still flags a payer holding more than its own gas', () => {
    const problems = diagnose({ ...healthy, ownerBalance: '0', payerBalance: '0.5', payerReserve: 0.1 });
    expect(problems[0]).toMatch(/bypass the permission/);
  });

  it('blames the connection only when both balance reads failed', () => {
    expect(diagnose({ ...healthy, ownerBalance: null, payerBalance: null })[0]).toMatch(/Check the API key/);
  });

  it('points at the address when only the owner read failed', () => {
    const problems = diagnose({ ...healthy, ownerBalance: null, payerBalance: '1' });
    expect(problems[0]).toMatch(/0xOwner/);
    expect(problems[0]).not.toMatch(/Check the API key/);
  });

  it('reports a used-up session cap with the way out', () => {
    const problems = diagnose({ ...healthy, spent: 10_000_000n });
    expect(problems[0]).toMatch(/cap is used up/);
    expect(problems[0]).toMatch(/jaw config set x402.maxTotalPerSession/);
  });

  it('treats spending past the cap the same as reaching it', () => {
    expect(diagnose({ ...healthy, spent: 99_000_000n })).toHaveLength(1);
  });

  it('does not fire the cap warning when there is no cap', () => {
    expect(diagnose({ ...healthy, spent: 99_000_000n, sessionCap: null })).toEqual([]);
  });

  // A grant-seeded session usually has no session cap at all, so checking only
  // that one stayed silent while the cap the chain enforces was exhausted.
  it('flags an exhausted per-period allowance even with no session cap', () => {
    const problems = diagnose({
      ...healthy,
      sessionCap: null,
      periodCap: 5_000_000n,
      periodSpent: 5_000_000n,
      periodLabel: 'day',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/granted allowance for this day is used up/i);
  });

  it('stays quiet while the period allowance still has room', () => {
    expect(diagnose({ ...healthy, periodCap: 5_000_000n, periodSpent: 1_000_000n, periodLabel: 'day' })).toEqual([]);
  });

  /**
   * The limit that binds is the one with the least room, and an allowance the
   * command cannot read has none: `checkPolicy` refuses every payment on it.
   * Reported ready, it sends an agent to a command that cannot pay.
   */
  it('flags a binding allowance it cannot read', () => {
    const problems = diagnose({ ...healthy, periodCap: null, periodSpent: null, periodLabel: 'day' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/granted allowance for this day cannot be read/i);
  });

  it('reports the period cap before the session cap when both are exhausted', () => {
    const problems = diagnose({
      ...healthy,
      spent: 10_000_000n,
      periodCap: 5_000_000n,
      periodSpent: 5_000_000n,
      periodLabel: 'day',
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/granted allowance/i);
    expect(problems[1]).toMatch(/session cap/i);
  });

  it('flags a chain with no USDC and skips the balance complaint', () => {
    const problems = diagnose({ ...healthy, hasAsset: false, ownerBalance: null, payerBalance: null });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no USDC configured/);
  });

  it('lists every problem when several hold at once', () => {
    const problems = diagnose({ ...healthy, expired: true, ownerBalance: '0', payerBalance: '0', spent: 10_000_000n });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/session expired/i);
  });
});

// `ready` in the JSON output is derived from this list, so an empty result has
// to mean the same thing the human output means when it prints no warnings.
describe('diagnose as a readiness verdict', () => {
  const healthy = {
    expired: false,
    ownerAddress: '0xOwner',
    ownerBalance: '12.5',
    payerBalance: '0',
    hasAsset: true,
    spent: 3_000_000n,
    sessionCap: 10_000_000n,
  };

  it('is empty exactly when the setup is usable', () => {
    expect(diagnose(healthy)).toHaveLength(0);
  });

  it('is non-empty for a setup that pays but bypasses the permission', () => {
    // The case that used to report ready:true while warning in the same breath.
    expect(diagnose({ ...healthy, ownerBalance: '0', payerBalance: '16.98' }).length).toBeGreaterThan(0);
  });
});

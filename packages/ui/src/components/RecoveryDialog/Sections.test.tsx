import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SIGNATURE_RECOVERY_PROVIDER_ADDRESS } from '@jaw.id/core';

import { GuardianList, NetworkStatusList, RecoveryTerms } from './Sections';

const HOUR = 3600;
const PROVIDER = SIGNATURE_RECOVERY_PROVIDER_ADDRESS;
const CAROL = `0x${'00'.repeat(12)}${'cc'.repeat(20)}` as const;

const ALICE = `0x${'00'.repeat(12)}${'aa'.repeat(20)}` as const;
const BOB = `0x${'00'.repeat(12)}${'bb'.repeat(20)}` as const;

/**
 * One list, as the team picked (option 1): the guardians after the change, new ones marked, then
 * the ones it removes, struck through. Nothing on it is editable.
 */
describe('the guardian list shows the end state and what changes', () => {
  const markup = (props: Partial<Parameters<typeof GuardianList>[0]> = {}) =>
    renderToStaticMarkup(
      <GuardianList
        rows={[
          { method: { commitment: CAROL, delay: 48 * HOUR, provider: PROVIDER }, change: 'added' },
          {
            method: { commitment: ALICE, delay: 72 * HOUR, provider: PROVIDER },
            change: 'delay',
            fromDelay: 48 * HOUR,
          },
          { method: { commitment: BOB, delay: 48 * HOUR, provider: PROVIDER }, change: 'removed' },
        ]}
        approvals={{ from: { threshold: 2, count: 2 }, to: { threshold: 1, count: 2 } }}
        mainnetRpcUrl="https://rpc"
        {...props}
      />
    );

  it('marks an added guardian', () => {
    expect(markup()).toContain('Added');
  });

  it('strikes a removed guardian through and marks it', () => {
    const html = markup();

    expect(html).toContain('Removed');
    expect(html).toContain('line-through');
  });

  it('shows a new wait against the old one', () => {
    expect(markup()).toContain('48h → 72h');
  });

  it('shows the approvals as before and after, the new value highlighted', () => {
    const html = markup();

    expect(html).toContain('2/2');
    expect(html).toContain('1/2');
    expect(html).toContain('bg-warning');
  });

  it('shows the approvals alone when they do not change', () => {
    const html = markup({
      rows: [{ method: { commitment: CAROL, delay: 48 * HOUR, provider: PROVIDER }, change: null }],
      approvals: { from: { threshold: 1, count: 1 }, to: { threshold: 1, count: 1 } },
    });

    expect(html).toContain('1/1');
    expect(html).not.toContain('→');
    expect(html).not.toContain('bg-warning');
  });

  it('offers nothing to edit: no input, no button', () => {
    const html = markup();

    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
  });
});

/** One line under the list: how long the owner has to cancel, where, and who pays. */
describe('the terms say how long a recovery waits', () => {
  const markup = (minimumDelay: number, feesPaidByJaw = false) =>
    renderToStaticMarkup(
      <RecoveryTerms minimumDelay={minimumDelay} networks="Base Sepolia" feesPaidByJaw={feesPaidByJaw} />
    );

  it('says the wait, the network, and nothing about fees on a first setup', () => {
    const html = markup(48 * HOUR);

    expect(html).toContain('48h');
    expect(html).toContain('you can cancel it before then');
    expect(html).toContain('Base Sepolia');
    expect(html).not.toContain('fees paid by JAW');
  });

  it('says JAW pays for an edit', () => {
    expect(markup(48 * HOUR, true)).toContain('fees paid by JAW');
  });

  it('advises on a short veto window', () => {
    expect(markup(60)).toContain('Short veto window');
  });

  it('says when recovery can complete instantly', () => {
    const html = markup(0);

    expect(html).toContain('instantly');
    expect(html).toContain('No waiting period');
  });
});

describe('the outcome lists each network as the relayer reports it', () => {
  it('maps every status to what it means for the user', () => {
    const html = renderToStaticMarkup(
      <NetworkStatusList
        chains={[
          { chainId: 84_532, status: 'COMPLETED', txHash: `0x${'ab'.repeat(32)}` },
          { chainId: 8453, status: 'SUBMITTED', txHash: null },
          { chainId: 1, status: 'SKIPPED', txHash: null },
          { chainId: 10, status: 'DEAD', txHash: null },
        ]}
      />
    );

    expect(html).toContain('Active');
    expect(html).toContain('Updating…');
    expect(html).toContain('Already up to date');
    expect(html).toContain('Didn’t go through');
    expect(html).toContain('/tx/0xabab');
  });
});

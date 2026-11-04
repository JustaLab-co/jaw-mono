import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SIGNATURE_RECOVERY_PROVIDER_ADDRESS, type RecoveryNetwork } from '@jaw.id/core';

import { GuardianList, NetworkStatusList, RecoveryNetworks, RecoveryTerms } from './Sections';

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

/** One line under the list: how long the owner has to cancel. */
describe('the terms say how long a recovery waits', () => {
  const markup = (minimumDelay: number) => renderToStaticMarkup(<RecoveryTerms minimumDelay={minimumDelay} />);

  it('says the wait and that the owner can cancel before it ends', () => {
    const html = markup(48 * HOUR);

    expect(html).toContain('48h');
    expect(html).toContain('you can cancel it before then');
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

/**
 * Before the user confirms, every network the account is on and what the change does there; the
 * networks it was never used on are not rows, and a line says they aren't covered yet. Each
 * outcome takes one row however many networks share it.
 */
describe('the networks section says where the change goes, before confirming', () => {
  const config = { deployed: true, enrolled: true, threshold: 0, recoveries: [] };
  const network = (chainId: number, status: RecoveryNetwork['status'], enabledByTransaction?: boolean) =>
    ({ chainId, status, enabledByTransaction, config: { ...config, chainId } }) satisfies RecoveryNetwork;
  const markup = (networks: RecoveryNetwork[], connectedChainId?: number) =>
    renderToStaticMarkup(<RecoveryNetworks networks={networks} connectedChainId={connectedChainId} />);
  const count = (html: string, text: string) => html.split(text).length - 1;
  const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

  it('gives each network its own row, with the reason, when two or fewer share an outcome', () => {
    const html = markup([
      network(8453, 'ready'),
      network(84_532, 'ready'),
      network(11_155_111, 'out-of-sync'),
      network(10, 'not-owner'),
    ]);

    expect(count(html, '>Included<')).toBe(2);
    expect(count(html, 'Not included')).toBe(2);
    expect(html).toContain('Different guardians');
    expect(html).toContain('Can’t be changed with this passkey');
    expect(html).not.toContain('aria-expanded');
  });

  it('says why each kind of network is left out', () => {
    const reason = (status: RecoveryNetwork['status'], enabledByTransaction?: boolean) =>
      markup([network(84_532, 'ready'), network(10, status, enabledByTransaction)]);

    expect(reason('not-available')).toContain('Not available for this account');
    expect(reason('not-available', true)).toContain('After your next transaction there');
  });

  it('lists the connected network first', () => {
    const html = markup([network(8453, 'ready'), network(84_532, 'ready')], 84_532);

    expect(html.indexOf('Base Sepolia')).toBeLessThan(html.indexOf('>Base<'));
  });

  it('folds three or more networks with one outcome into one row: their icons and the count', () => {
    const html = markup(ids(1000, 7).map((chainId) => network(chainId, 'ready')));

    expect(count(html, '>Included<')).toBe(1);
    expect(html).toContain('7 networks');
    expect(html).toContain('+2');
    expect(html).toContain('aria-expanded="false"');
  });

  it('folds the networks left out under one row too, still marked as not included', () => {
    const html = markup([network(84_532, 'ready'), ...ids(1000, 3).map((chainId) => network(chainId, 'not-owner'))]);

    expect(html).toContain('3 networks');
    expect(count(html, 'Not included')).toBe(1);
  });

  it('keeps the card two rows at forty networks', () => {
    const html = markup([
      ...ids(1000, 40).map((chainId) => network(chainId, 'ready')),
      ...ids(2000, 10).map((chainId) => network(chainId, 'out-of-sync')),
    ]);

    expect(html).toContain('40 networks');
    expect(html).toContain('10 networks');
    expect(count(html, 'aria-expanded')).toBe(2);
  });

  it('leaves out the networks the account was never used on, and says they are not covered yet', () => {
    const html = markup([network(84_532, 'ready'), network(1, 'not-deployed', true)]);

    expect(html).not.toContain('Ethereum');
    expect(html).toContain('Networks you haven’t used this account on aren’t covered yet.');
  });

  it('says nothing about unused networks when the account is on every one', () => {
    expect(markup([network(84_532, 'ready')])).not.toContain('aren’t covered yet');
  });

  it('says JAW pays the network fees', () => {
    expect(markup([network(84_532, 'ready')])).toContain('Paid by JAW');
  });

  it('renders nothing when the account is on no network yet', () => {
    expect(markup([network(84_532, 'not-deployed', true)])).toBe('');
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

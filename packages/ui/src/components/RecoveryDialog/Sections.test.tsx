import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SIGNATURE_RECOVERY_PROVIDER_ADDRESS } from '@jaw.id/core';

import { ChangeList, GuardianList, NetworkStatusList, RecoverySummary } from './Sections';

const HOUR = 3600;
const PROVIDER = SIGNATURE_RECOVERY_PROVIDER_ADDRESS;
const CAROL = `0x${'00'.repeat(12)}${'cc'.repeat(20)}` as const;

const ALICE = `0x${'00'.repeat(12)}${'aa'.repeat(20)}` as const;

/**
 * The screen displays and approves, as the permission screen does: nothing on it is editable.
 */
describe('the guardian list shows the config, read-only', () => {
  const markup = () =>
    renderToStaticMarkup(
      <GuardianList
        label="Guardians"
        methods={[
          { commitment: ALICE, delay: 48 * HOUR, provider: PROVIDER },
          { commitment: CAROL, delay: 72 * HOUR, provider: PROVIDER },
        ]}
        threshold={2}
        mainnetRpcUrl="https://rpc"
      />
    );

  it('shows each guardian with how it approves and its wait', () => {
    const html = markup();

    expect(html).toContain('0xaaaa...aaaa');
    expect(html).toContain('Wallet');
    expect(html).toContain('48h');
    expect(html).toContain('72h');
  });

  it('shows the approvals the config needs', () => {
    expect(markup()).toContain('2 of 2');
  });

  it('offers nothing to edit: no input, no remove, no wait or threshold control', () => {
    const html = markup();

    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
  });
});

/** Where the owner learns how long they have to veto, and where the change lands. */
describe('the summary states the time to cancel and the networks', () => {
  const markup = (minimumDelay: number) =>
    renderToStaticMarkup(
      <RecoverySummary minimumDelay={minimumDelay} networkLabel="Network" networks="Base Sepolia" />
    );

  it('says the guaranteed minimum and the network', () => {
    const html = markup(48 * HOUR);

    expect(html).toContain('at least 48h');
    expect(html).toContain('Base Sepolia');
    expect(html).not.toContain('Short veto window');
  });

  it('advises on a short veto window', () => {
    expect(markup(60)).toContain('Short veto window');
  });

  it('says when recovery can complete instantly', () => {
    expect(markup(0)).toContain('No waiting period');
  });
});

describe('the change list reads like the edit, not like the ops', () => {
  const markup = (changes: Parameters<typeof ChangeList>[0]['changes']) =>
    renderToStaticMarkup(<ChangeList changes={changes} mainnetRpcUrl="https://rpc" />);

  it('shows an added guardian with its wait', () => {
    const html = markup([{ kind: 'add', method: { commitment: CAROL, delay: 48 * HOUR, provider: PROVIDER } }]);

    expect(html).toContain('aria-label="Added"');
    expect(html).toContain('0xcccc...cccc');
    expect(html).toContain('48h');
  });

  it('shows a changed wait as from and to', () => {
    const html = markup([
      { kind: 'delay', method: { commitment: CAROL, delay: 72 * HOUR, provider: PROVIDER }, from: 48 * HOUR },
    ]);

    expect(html).toContain('48h → 72h');
  });

  it('shows a new threshold as from and to', () => {
    expect(markup([{ kind: 'threshold', from: 2, to: 1 }])).toContain('Approvals needed 2 → 1');
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

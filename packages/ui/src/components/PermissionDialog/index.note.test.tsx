// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../hooks/useAddressIdentities', () => ({ useAddressIdentities: () => ({}) }));

import { PermissionDialog } from './index';

const LONG_NOTE = `Pays the monthly rent to the landlord on the first of each month. ${'x'.repeat(200)}`.slice(0, 200);

const render = (mode: 'grant' | 'revoke', note?: string) =>
  renderToStaticMarkup(
    <PermissionDialog
      open
      onOpenChange={() => undefined}
      mode={mode}
      permissionId={mode === 'revoke' ? `0x${'ab'.repeat(32)}` : undefined}
      spenderAddress="0x2222222222222222222222222222222222222222"
      accountAddress="0x1111111111111111111111111111111111111111"
      origin="https://dapp.example"
      calls={[
        {
          target: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          selector: '0xa9059cbb',
          functionSignature: 'transfer(address,uint256)',
        },
      ]}
      expiryDate="11/19/2026"
      note={note}
      networkName="Base Sepolia"
      chainId={84532}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      gasFee="0.0001"
      sponsored
      mainnetRpcUrl="https://mainnet.example"
    />
  );

/** The text of the row labeled Note, or undefined when there is none. */
function noteRow(html: string): { text: string; html: string } | undefined {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const label = [...doc.querySelectorAll('*')].find(
    (el) => el.children.length === 0 && el.textContent?.trim() === 'Note'
  );
  // The row is the first element around the label that holds more than the label.
  let row = label?.parentElement;
  while (row && row.textContent?.trim() === 'Note') row = row.parentElement;
  if (!row) return undefined;
  return { text: row.textContent ?? '', html: row.outerHTML };
}

describe.each(['grant', 'revoke'] as const)('the %s screen and a note', (mode) => {
  it('shows the note in quotes on a row labeled Note', () => {
    const row = noteRow(render(mode, 'Daily DCA into ETH'));

    expect(row?.text).toContain('“Daily DCA into ETH”');
  });

  it('has no Note row when the permission has no note', () => {
    expect(noteRow(render(mode))).toBeUndefined();
  });

  it('shows a 200-character note in full, wrapping rather than cutting it off', () => {
    const row = noteRow(render(mode, LONG_NOTE));

    expect(row?.text).toContain(LONG_NOTE);
    // No class that cuts text off or pins the row to one line.
    const classes = [...(row?.html.matchAll(/class="([^"]*)"/g) ?? [])].flatMap((m) => m[1].split(/\s+/));
    expect(classes).not.toContain('truncate');
    expect(classes).not.toContain('h-7');
  });

  it('shows the note after Until, under the permission facts', () => {
    const html = render(mode, 'Daily DCA into ETH');

    expect(html.indexOf('Until')).toBeGreaterThan(-1);
    expect(html.indexOf('Daily DCA into ETH')).toBeGreaterThan(html.indexOf('Until'));
  });
});

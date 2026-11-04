// @vitest-environment jsdom
// A folded row opens in place: every network it stood for, each with the reason it is left out.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RecoveryNetwork } from '@jaw.id/core';

vi.mock('../../hooks/useChainIcons', () => ({ useChainIcons: () => ({}) }));

const { RecoveryNetworks } = await import('./Sections');

const config = { deployed: true, enrolled: true, threshold: 0, recoveries: [] };
const network = (chainId: number, status: RecoveryNetwork['status']) =>
  ({ chainId, status, config: { ...config, chainId } }) satisfies RecoveryNetwork;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a folded row of networks', () => {
  it('opens to list every network with its reason, and closes again', async () => {
    await act(async () =>
      root.render(
        <RecoveryNetworks
          networks={[
            network(84_532, 'ready'),
            network(8453, 'out-of-sync'),
            network(10, 'not-owner'),
            network(11_155_111, 'out-of-sync'),
          ]}
        />
      )
    );
    const folded = container.querySelector<HTMLButtonElement>('button[aria-expanded]');

    expect(folded?.textContent).toContain('3 networks');
    expect(container.textContent).not.toContain('Different guardians');

    await act(async () => folded?.click());

    expect(folded?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Base');
    expect(container.textContent).toContain('OP Mainnet');
    expect(container.textContent).toContain('Sepolia');
    expect(container.textContent?.split('Different guardians').length).toBe(3);
    expect(container.textContent).toContain('Can’t be changed with this passkey');

    await act(async () => folded?.click());

    expect(folded?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Different guardians');
  });
});

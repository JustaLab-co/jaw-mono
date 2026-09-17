import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChainStack } from './ChainStack';

/**
 * Rendered rather than unit-tested through a helper: the feature IS "fewer
 * icons appear", so the seam is the component's props, and a helper extracted
 * to be callable from a test would only prove the helper agrees with itself.
 *
 * `renderToStaticMarkup` needs no DOM, which is why this runs under the
 * package's `environment: 'node'`. Effects do not run, so `useChainIcons`
 * contributes no network call and every icon renders as its placeholder — the
 * icons are not what is under test here, the set and order of them is.
 */

/** The chains the row says it is showing, in render order. */
function chainsShown(markup: string): string[] {
  const label = /aria-label="([^"]*)"/.exec(markup)?.[1];
  if (!label) throw new Error('ChainStack rendered no aria-label naming its chains');
  return label.replace(/^(?:Works|Accepted) on /, '').split(', ');
}

/** What the row claims about the set: where the address works, or where deposits land. */
function claim(markup: string): string {
  return /aria-label="((?:Works|Accepted) on)/.exec(markup)?.[1] ?? '';
}

/**
 * One per chain icon actually drawn, which is capped below the full set — see
 * MAX_SHOWN.
 *
 * Counts `data-testid`, not `tooltip-trigger` and not the class list. The
 * overflow "+N" pill is a trigger too, so counting triggers reports one icon
 * too many; and the repo runs `prettier-plugin-tailwindcss`, which reorders
 * class names, so a class-based count breaks the moment a utility is added.
 */
function iconCount(markup: string): number {
  return markup.match(/data-testid="chain-icon"/g)?.length ?? 0;
}

const render = (activeChainId: number, chains?: number[]) =>
  renderToStaticMarkup(<ChainStack activeChainId={activeChainId} chains={chains} />);

// Names, not ids: these are what a user reads off the row, and they are literals
// here rather than looked up from SUPPORTED_CHAINS — a lookup would be the same
// call the component makes, so the assertion could never disagree with it.
const ETHEREUM = 'Ethereum';
const BASE = 'Base';
const OPTIMISM = 'OP Mainnet';
const ARBITRUM = 'Arbitrum One';
const BASE_SEPOLIA = 'Base Sepolia';

const BASE_ID = 8453;
const OPTIMISM_ID = 10;
const BASE_SEPOLIA_ID = 84532;

describe('ChainStack', () => {
  describe('when the dapp names no chains', () => {
    it('offers every mainnet, led by the chain the QR pins', () => {
      const markup = render(BASE_ID);

      expect(chainsShown(markup)[0]).toBe(BASE);
      expect(chainsShown(markup)).toContain(ARBITRUM);
    });

    // A testnet shares its mainnet's icon, so leading with it drew the same logo
    // twice and read as a duplicate rather than as two networks.
    it('leaves a testnet active chain out instead of leading with it', () => {
      const markup = render(BASE_SEPOLIA_ID);

      expect(chainsShown(markup)).not.toContain(BASE_SEPOLIA);
      expect(chainsShown(markup)[0]).toBe(ETHEREUM);
    });

    // The row is a statement about where the address exists, not a restriction.
    it('says the address works on them', () => {
      expect(claim(render(BASE_ID))).toBe('Works on');
    });

    // The supported mainnets have outgrown MAX_SHOWN, so the default row no
    // longer fits them all and spills into a "+N" pill.
    //
    // Asserted as a relationship rather than as today's chain count: pinning the
    // literal numbers meant adding any unrelated chain failed an Add Funds test,
    // for no reason a reader could act on. This still fails the day the cap is
    // revisited so the whole set fits — which is what the cap's own comment asks
    // for, since it argues that outgrowing the row calls for a rethink rather
    // than a bigger number.
    it('draws no more icons than the cap, spilling the rest into the overflow pill', () => {
      const markup = render(BASE_ID);

      expect(iconCount(markup)).toBeLessThan(chainsShown(markup).length);
      expect(markup).toContain('+');
    });
  });

  describe('when the dapp names its chains', () => {
    // The case this feature exists for: an app operating on Base alone should
    // not invite a deposit on Arbitrum.
    it('shows one icon for a single-chain app', () => {
      const markup = render(BASE_ID, [BASE_ID]);

      expect(chainsShown(markup)).toEqual([BASE]);
      expect(iconCount(markup)).toBe(1);
    });

    it('shows exactly the named chains for a multichain app', () => {
      const markup = render(BASE_ID, [BASE_ID, OPTIMISM_ID]);

      expect(chainsShown(markup)).toEqual([BASE, OPTIMISM]);
      expect(iconCount(markup)).toBe(2);
      expect(chainsShown(markup)).not.toContain(ARBITRUM);
    });

    it('leads with the chain the QR pins', () => {
      expect(chainsShown(render(OPTIMISM_ID, [BASE_ID, OPTIMISM_ID]))).toEqual([OPTIMISM, BASE]);
    });

    // The list was deliberately named and already passed `resolveChain`, so
    // dropping a testnet would leave the row contradicting the QR.
    it('keeps a testnet the dapp asked for', () => {
      expect(chainsShown(render(BASE_SEPOLIA_ID, [BASE_SEPOLIA_ID]))).toEqual([BASE_SEPOLIA]);
    });

    // The SDK refuses this combination outright, but the keys host can still
    // produce it: it drops unsupported entries and falls back on the QR chain
    // independently, so the two disagree after validation. The list wins —
    // adding a chain the dapp never named would invite a deposit it does not
    // credit.
    it('does not add the pinned chain to a list that omits it', () => {
      expect(chainsShown(render(OPTIMISM_ID, [BASE_ID]))).toEqual([BASE]);
    });

    // The set is now a restriction, so the wording stops claiming reach.
    it('says deposits are accepted on them', () => {
      expect(claim(render(BASE_ID, [BASE_ID]))).toBe('Accepted on');
    });
  });
});

'use client';

import { useMemo } from 'react';
import { MAINNET_CHAINS, SUPPORTED_CHAINS } from '@jaw.id/core';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useChainIcons } from '../../hooks/useChainIcons';
import { ChainIcon } from './ChainIcon';

/**
 * Icons shown before the rest collapse into a "+N".
 *
 * High enough to stack every mainnet we support today, because a "+10" beside
 * five icons is a count rather than information, and showing the set is the
 * whole point. The cap stays as a guard: if the supported list outgrows the row
 * this needs a rethink, not a wider row.
 */
const MAX_SHOWN = 16;

/**
 * Icon size and the step between them, in px.
 *
 * A 10px step on a 20px icon hid half of every logo and the row read as a smear
 * of crescents. 14 leaves most of each logo visible while still overlapping
 * enough to read as one stack rather than a list.
 */
const ICON = 20;
const STEP = 14;

export interface ChainStackProps {
  /** The chain the QR pins. Leads the stack when it is a mainnet; a testnet is left out (see below). */
  activeChainId: number;
  apiKey?: string;
}

/**
 * The overlapping chain icons beside "Receive on".
 *
 * Informational, not a control: a smart account has the same address on every
 * chain, so this says where the address works rather than offering a choice.
 * Making it a picker would imply the address changes with the selection.
 *
 * The list is derived here rather than passed in. It is a display decision, not
 * a fact about the request, so nothing needs to travel through the signer and
 * the two hosts cannot drift apart — the CrossPlatform popup only ever learns
 * one chain, so anything plumbed through produced a stack of one there.
 */
export function ChainStack({ activeChainId, apiKey }: ChainStackProps) {
  // One request for every icon. Per-chain fetching here meant 14 round trips on
  // open, one per mainnet, because the capabilities cache keys on the params.
  const icons = useChainIcons(apiKey);

  const ordered = useMemo(() => {
    const mainnets = MAINNET_CHAINS.map((c) => c.id);

    // Mainnets only. A testnet means nothing to someone about to send real
    // funds, and adding the active one when it is a testnet drew the same logo
    // twice: a testnet shares its mainnet's icon, so Base Sepolia beside Base
    // read as a duplicate rather than as two networks.
    if (mainnets.includes(activeChainId)) {
      return [activeChainId, ...mainnets.filter((id) => id !== activeChainId)];
    }
    return mainnets;
  }, [activeChainId]);

  const shown = ordered.slice(0, MAX_SHOWN);
  const overflow = ordered.length - shown.length;

  return (
    // The list carries the full names so a screen reader gets "Base, Optimism"
    // rather than a run of unlabelled images.
    <span className="flex items-center" aria-label={`Works on ${ordered.map(chainName).join(', ')}`} role="img">
      {shown.map((id, i) => (
        <Tooltip key={id}>
          {/* Hover-only, no tabIndex: a focusable trigger opens by itself when
              the dialog moves focus in on mount. The container's aria-label
              already names every chain, so nothing is lost for screen readers. */}
          <TooltipTrigger asChild>
            <span
              // White plate, not a themed one: these logos are brand SVGs with
              // transparent grounds, drawn for light backgrounds. On the dark
              // dialog the transparency let the surface through and the marks
              // read as holes. The ring stays the surface colour so each icon
              // still separates from the one behind it.
              className="ring-popover relative inline-flex overflow-hidden rounded-full bg-white ring-2"
              // Descending z-index so each icon overlaps the next, which is what
              // makes the row read left to right. Hover targets the visible
              // crescent rather than the whole circle, which is the trade for a
              // stack: the alternative is no overlap at all.
              style={{ marginLeft: i === 0 ? 0 : -(ICON - STEP), zIndex: shown.length - i }}
            >
              <ChainIcon icon={icons[id]} size={ICON} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{chainName(id)}</TooltipContent>
        </Tooltip>
      ))}
      {overflow > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="ring-popover bg-secondary text-muted-foreground text-label relative inline-flex h-5 items-center justify-center rounded-full px-1.5 font-mono ring-2"
              style={{ marginLeft: -(ICON - STEP) }}
            >
              +{overflow}
            </span>
          </TooltipTrigger>
          {/* Names what the count hides, so the collapsed chains are still
              discoverable rather than being an unexplained number. */}
          <TooltipContent>{ordered.slice(MAX_SHOWN).map(chainName).join(', ')}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/** A chain's display name, falling back to the id for one we don't carry. */
function chainName(chainId: number): string {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId)?.name ?? `chain ${chainId}`;
}

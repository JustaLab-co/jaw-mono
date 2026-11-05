'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CopiedIcon, CopyIcon } from '../../icons';
import { cn } from '../../lib/utils';

/**
 * Copy-to-clipboard icon button that swaps to a tick for `resetAfterMs`.
 *
 * A real <button> so it's keyboard-reachable and labelled for screen readers.
 * The button persists across the icon swap (only its child changes) so focus
 * survives activation, and an SR-only live region announces the copy.
 * Icons draw in `currentColor`, so color the button (className) to tint them. Children, when
 * given, are a visible label after the icon.
 */
export function CopyButton({
  value,
  size = 14,
  className,
  resetAfterMs = 3000,
  label = 'Copy',
  children,
}: {
  value: string;
  size?: number;
  /** Applied to the <button>; the icons inherit its text color. */
  className?: string;
  resetAfterMs?: number;
  /** Accessible name, e.g. "Copy address". */
  label?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        'm-0 inline-flex flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-inherit focus-visible:outline-none focus-visible:ring-1',
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (typeof navigator === 'undefined' || !navigator.clipboard) return;
        navigator.clipboard.writeText(value).catch(() => undefined);
        setCopied(true);
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), resetAfterMs);
      }}
    >
      {copied ? (
        <CopiedIcon width={size} height={size} className="flex-none" />
      ) : (
        <CopyIcon width={size} height={size} className="flex-none" />
      )}
      {children}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}

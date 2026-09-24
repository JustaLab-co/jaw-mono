'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Playground v2 shell primitives — presentational only. Both /core and /wagmi
 * compose these with their own (untouched) state and handlers.
 */

/** Pill container for a segmented control (mockup `role="group"` rows). */
export function SegGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="border-shell-line bg-shell-raise flex gap-[3px] rounded-full border p-[3px]"
    >
      {children}
    </div>
  );
}

/**
 * Focus indicator for controls that suppress the browser default — shadcn's
 * `ring-ring` pair in shell tokens. Anything setting `outline-none` needs it.
 */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-shell-ink-4 focus-visible:ring-offset-2 focus-visible:ring-offset-shell-raise';

/** Class string for one segment inside a SegGroup (button or Link). */
export function segClass(active: boolean, extra = ''): string {
  return [
    'rounded-full border px-[13px] py-1.5 text-[12.5px] font-medium whitespace-nowrap tracking-[-0.005em] transition-colors cursor-pointer',
    active
      ? 'bg-shell-active border-shell-line-2 text-shell-ink'
      : 'border-transparent bg-transparent text-shell-ink-3 hover:text-shell-ink-2',
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Info popover: circular "i" trigger + floating panel, closed by outside
 * pointerdown or Escape (the mockup's `data-pop` pattern, scoped by ref).
 */
export function InfoPopover({
  label,
  children,
  panelClassName = 'right-0 w-[352px]',
  triggerClassName = 'h-[26px] w-[26px] border-shell-line-2 border',
}: {
  label: string;
  children: ReactNode;
  /** Positioning + sizing of the floating panel relative to the trigger. */
  panelClassName?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`text-shell-ink-2 inline-flex flex-none cursor-pointer items-center justify-center rounded-full bg-transparent p-0 ${triggerClassName}`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5.5" />
          <path d="M12 7.8v.3" />
        </svg>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`border-shell-line-2 bg-shell-pop animate-fade-up absolute top-[calc(100%+10px)] z-[60] rounded-[14px] border p-[18px] shadow-[0_30px_60px_-30px_rgba(15,23,42,.35)] max-md:fixed max-md:inset-x-4 max-md:bottom-4 max-md:top-auto max-md:max-h-[70vh] max-md:w-auto max-md:overflow-y-auto dark:shadow-[0_30px_60px_-30px_rgba(0,0,0,.8)] ${panelClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Mono chip that copies its text on click (address / ENS / chain id). */
export function CopyChip({ text, display }: { text: string; display?: string }) {
  return (
    <button
      type="button"
      title="Click to copy"
      onClick={() => navigator.clipboard.writeText(text)}
      className="bg-shell-raise-2 text-shell-ink-2 hover:text-shell-ink cursor-pointer rounded-full px-2.5 py-1 font-mono text-xs transition-colors"
    >
      {display ?? text}
    </button>
  );
}

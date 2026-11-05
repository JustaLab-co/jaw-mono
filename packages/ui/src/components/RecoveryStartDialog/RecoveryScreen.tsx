'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * One screen of the recovery flow, laid out as the recovery setup screen is: the content scrolls,
 * the footer stays pinned under it.
 */
export function RecoveryScreen({
  children,
  footer,
  footerBorder = true,
  className,
}: {
  children: ReactNode;
  footer?: ReactNode;
  /** The hairline over the footer; the find screen draws none. */
  footerBorder?: boolean;
  /** Extra classes for the scrolling content, e.g. a taller top inset. */
  className?: string;
}) {
  // Inside a Radix modal a nested container's wheel events get eaten: drive scrollTop manually.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollHeight <= el.clientHeight) return;
      el.scrollTop += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className={cn('jaw-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-3 pt-6', className)}
      >
        {children}
      </div>
      {footer && (
        <div className={cn('flex-none space-y-2 px-6 pb-5 pt-3', footerBorder && 'border-border/40 border-t')}>
          {footer}
        </div>
      )}
    </div>
  );
}

/** A screen's title and the line under it. Clear of the shell's close button on the right. */
export function RecoveryScreenTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pr-8">
      <h2 className="text-foreground text-title-xl">{title}</h2>
      {children && <p className="text-muted-foreground text-body mt-2">{children}</p>}
    </div>
  );
}

/** Back to the previous screen, in the dialog's mono label style, as on the sign-in screen. */
export function RecoveryBackButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // A 44px target around a 10px label; the negative margins keep the label where the sign-in
      // screen puts its own.
      className="text-muted-foreground hover:text-foreground text-label -mb-1 -ml-1 -mt-3 flex min-h-11 w-fit cursor-pointer items-center gap-1 bg-transparent pr-2 font-mono uppercase transition-colors"
    >
      <ChevronLeft className="size-3.5" />
      Back
    </button>
  );
}

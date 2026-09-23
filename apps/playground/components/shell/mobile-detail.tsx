'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * Below `md` the shell is list-then-detail: the sidebar (method list) and the
 * method detail take turns filling the screen, and the document scrolls. From
 * `md` up both panes are always shown and this state has no visual effect.
 */
export function useMobileDetail() {
  const [showDetail, setShowDetail] = useState(false);
  // Where the list was scrolled, so Back lands on the method you came from.
  const listScroll = useRef(0);
  const pendingScroll = useRef<number | null>(null);

  const openDetail = useCallback(() => {
    listScroll.current = window.scrollY;
    pendingScroll.current = 0;
    setShowDetail(true);
  }, []);

  const closeDetail = useCallback(() => {
    pendingScroll.current = listScroll.current;
    setShowDetail(false);
  }, []);

  // Scroll once the swapped pane is in the DOM, so the target offset exists.
  useLayoutEffect(() => {
    if (pendingScroll.current === null) return;
    window.scrollTo(0, pendingScroll.current);
    pendingScroll.current = null;
  }, [showDetail]);

  return { showDetail, openDetail, closeDetail };
}

/** Mobile-only "back to the method list" control; hidden from `md` up. */
export function MobileBackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-shell-line-2 bg-shell-raise text-shell-ink hover:bg-shell-raise-2 mr-auto inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border py-2 pl-3 pr-4 text-base font-semibold tracking-[-0.01em] transition-colors md:hidden"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M15 6l-6 6 6 6" />
      </svg>
      Methods
    </button>
  );
}

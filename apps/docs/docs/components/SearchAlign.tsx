'use client';

import { useEffect } from 'react';

const MIN_WIDTH = 240;
const NAV_GAP = 16;

// Stretches the top-bar search over the content column of the current page,
// so it shrinks with the viewport and its edges line up with the text below.
export function SearchAlign() {
  useEffect(() => {
    const align = () => {
      const box = document.querySelector<HTMLElement>(
        '[data-v-gutter-top-left] > div:has(> button[data-base-ui-click-trigger])'
      );
      if (!box) return;
      box.style.width = '';
      box.style.marginLeft = '';

      const column = document.querySelector('article :is(h1, h2)')?.getBoundingClientRect();
      const bar = box.parentElement;
      if (!column || !bar?.parentElement) return;

      // The nav links collapse into a menu button on narrow screens, so take
      // whichever top-bar item is visible to the right of the search.
      const navLeft = Math.min(
        ...[...bar.parentElement.children]
          .filter((el) => el !== bar)
          .map((el) => el.getBoundingClientRect())
          .filter((rect) => rect.width > 0)
          .map((rect) => rect.left)
      );

      const start = box.getBoundingClientRect().left;
      const left = Math.max(column.left, start);
      const right = Math.min(column.right, navLeft - NAV_GAP);
      if (right - left < MIN_WIDTH) return;

      box.style.marginLeft = `${left - start}px`;
      box.style.width = `${right - left}px`;
    };

    align();
    const observer = new MutationObserver(align);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', align);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', align);
    };
  }, []);

  return null;
}

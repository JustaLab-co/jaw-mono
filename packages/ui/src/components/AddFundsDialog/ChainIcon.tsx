'use client';

/**
 * One chain's icon in the stack, from an icon map the parent already fetched.
 *
 * Presentational on purpose. This used to call `useChainIconURI` so that each
 * icon had its own component to hold the hook, which meant one capabilities
 * request per chain. The stack now fetches every icon in one request
 * (`useChainIcons`) and passes the URI down, so there is no hook to hold and no
 * reason for this to be anything but an `<img>`.
 */
export function ChainIcon({ icon, size = 20 }: { icon?: string; size?: number }) {
  if (!icon) {
    // No icon yet, or none in the catalogue. A neutral disc keeps the row's
    // geometry stable so icons landing later do not shift the stack.
    return (
      <span
        aria-hidden
        className="bg-secondary block rounded-full"
        style={{ width: size, height: size, minWidth: size }}
      />
    );
  }

  return (
    <img
      src={icon}
      alt=""
      width={size}
      height={size}
      // Decorative: the name is on the stack's aria-label for screen readers and
      // on the Radix tooltip for pointers. No `title` — that drew the browser's
      // own tooltip on top of the styled one, naming the chain twice.
      className="block rounded-full"
      style={{ width: size, height: size, minWidth: size }}
    />
  );
}

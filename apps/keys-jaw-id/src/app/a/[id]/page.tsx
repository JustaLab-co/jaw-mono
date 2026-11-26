'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import CLIBridge from '../../cli-bridge/bridge';
import { openShortLink, type OpenedLink } from '../../../lib/short-link';

/**
 * A short owner link, `/a/<id>#<key>`. The key is read once and stripped from the address before any request, then
 * opens the stored blob into the values of the long link, and the bridge runs on them without ever putting them back
 * in the address.
 */
export default function ShortLinkPage() {
  const { id } = useParams<{ id: string }>();
  const [opened, setOpened] = useState<OpenedLink | 'damaged' | null>(null);
  // Strict Mode runs the effect twice, and the second run finds the fragment already gone.
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = (keyRef.current ??= window.location.hash.slice(1));
    window.history.replaceState(null, '', window.location.pathname);
    // A reload has no key. A tab that opened this link before hands the bridge its session with no key, so the
    // bridge says the request is done, or that the tab lost its link, as it does for a long link.
    if (!key) return setOpened(seenIn(id) ?? 'damaged');
    let live = true;
    openShortLink(id, key).then((opened) => {
      // A batch link has no screen yet, so it reads as a link this page cannot open.
      const link = opened && 'session' in opened ? opened : undefined;
      if (link) remember(id, link);
      if (live) setOpened(link ?? 'damaged');
    });
    return () => {
      live = false;
    };
  }, [id]);

  if (opened === null) return <Screen>Loading...</Screen>;
  if (opened === 'damaged') {
    return (
      <Screen>
        <span className="text-destructive block text-base font-semibold">Error</span>
        This link is damaged or has expired. Ask the agent for a new one.
      </Screen>
    );
  }
  return <CLIBridge opened={opened} />;
}

const SEEN_KEY = 'short-link-seen:';

/** Keeps the session and relay of a link this tab opened, never its key or its secret. */
function remember(id: string, { session, relay }: OpenedLink) {
  try {
    sessionStorage.setItem(SEEN_KEY + id, JSON.stringify({ session, relay }));
  } catch {
    // Storage can be blocked; a reload then says the link is damaged.
  }
}

function seenIn(id: string): OpenedLink | undefined {
  try {
    const seen = JSON.parse(sessionStorage.getItem(SEEN_KEY + id) ?? 'null');
    return seen ? { session: seen.session, relay: seen.relay, fragment: '' } : undefined;
  } catch {
    return undefined;
  }
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center font-sans">
      <div className="max-w-md p-12 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/jaw-logo.png" alt="JAW" className="mx-auto mb-4 block h-12 w-12 opacity-80" />
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

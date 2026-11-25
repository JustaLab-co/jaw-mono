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
    let live = true;
    openShortLink(id, key).then((link) => live && setOpened(link ?? 'damaged'));
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

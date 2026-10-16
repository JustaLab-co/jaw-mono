import { JSX } from 'react';

import { sanitizeDisplayName } from '../../utils/sanitize';
import { AppAvatar } from '../AppAvatar';

export interface DialogAppHeaderProps {
  /** dApp name (externally-controlled metadata — sanitized before display). */
  appName?: string;
  /** dApp logo URL (validated https/data image; falls back to a globe glyph). */
  appLogoUrl?: string | null;
  /** dApp origin, shown truncated to the hostname. */
  origin: string;
  /** Shown in place of the host when the host would not say who is asking (the wallet's own bridge page). */
  originLabel?: string;
  chainName?: string;
  chainIcon?: JSX.Element;
}

/**
 * dApp origin → bare hostname for display.
 *
 * The `www.` strip is anchored: unanchored, it rewrites the first match anywhere in
 * the host, so `bawww.nk.com` would render as `bank.com` on the one line the user
 * relies on to identify who is asking them to sign.
 */
export function formatOrigin(origin: string): string {
  try {
    const url = new URL(origin.startsWith('http') ? origin : `https://${origin}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

/**
 * "Who's asking" header shared by the wallet dialogs: dApp logo (with a themed
 * border + chain badge), app name, and origin. Theme-adaptive via semantic tokens.
 */
export function DialogAppHeader({
  appName,
  appLogoUrl,
  origin,
  originLabel,
  chainName,
  chainIcon,
}: DialogAppHeaderProps) {
  const safeAppName = sanitizeDisplayName(appName ?? '') || 'dApp';

  const appAvatar = <AppAvatar appName={appName} appLogoUrl={appLogoUrl} />;

  return (
    // pr-9 clears the shell's close X: every consumer of this header sits in a ShellDialog that
    // pins one over the top-right corner, and a long app name would otherwise truncate under it.
    <div className="flex items-center gap-3 pr-9">
      <span className="relative flex-none">
        <span className="bg-secondary border-border size-logo flex items-center justify-center overflow-hidden rounded-full border">
          {appAvatar}
        </span>
        {chainIcon && (
          <span
            title={chainName}
            // Ring drawn with the card color so the badge reads as sitting on the
            // surface. The chain icon arrives pre-sized (inline 24px), so force it
            // down to the badge size or it renders cropped.
            className="border-popover bg-popover absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center overflow-hidden rounded-full border-2 [&>*]:!h-full [&>*]:!w-full [&>*]:!min-w-0"
          >
            {chainIcon}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-foreground text-app truncate">{safeAppName}</span>
        <span className="text-muted-foreground text-url truncate font-mono">{originLabel ?? formatOrigin(origin)}</span>
      </span>
    </div>
  );
}

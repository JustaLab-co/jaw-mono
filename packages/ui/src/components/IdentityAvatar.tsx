import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { WalletIcon } from '../icons';
import { cn } from '../lib/utils';

interface IdentityAvatarProps {
  src?: string;
  /** Defaults to the wallet icon; pass `null` to render nothing when there's no avatar. */
  fallback?: ReactNode;
  /** Size/shape classes; defaults to the 20px circle used by transaction rows. */
  className?: string;
  /** Accessible name. Empty (decorative) by default, as identity avatars sit beside their label. */
  alt?: string;
  /** Inline styles for the image, for sizes that aren't in the class scale (e.g. a px-computed overlay). */
  style?: CSSProperties;
}

const defaultFallback = <WalletIcon className="h-3 w-3 flex-shrink-0" stroke="currentColor" />;

/** ENS avatar for a resolved identity; falls back to `fallback` when there's no avatar or the image fails to load. */
export const IdentityAvatar = ({
  src,
  fallback = defaultFallback,
  className = 'size-5 rounded-full',
  alt = '',
  style,
}: IdentityAvatarProps) => {
  const [erroredSrc, setErroredSrc] = useState<string>();
  if (!src || erroredSrc === src) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      // Avatar URLs are attacker-controlled (ENS records) — no-referrer avoids leaking the wallet page URL (incl. api-key) to third-party hosts.
      referrerPolicy="no-referrer"
      onError={() => setErroredSrc(src)}
      className={cn('flex-shrink-0 object-cover', className)}
      style={style}
    />
  );
};

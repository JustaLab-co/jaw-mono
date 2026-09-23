'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { ThemeToggle } from '../theme-toggle';
import { SegGroup, segClass, InfoPopover, CopyChip } from './primitives';

export type ShellSdk = 'core' | 'wagmi';

export interface ShellHeaderProps {
  sdk: ShellSdk;
  isConnected: boolean;
  /** Runs the page's existing connect/disconnect method flow — logic untouched. */
  onToggleConnect: () => void;
  address?: string;
  ensName?: string | null;
  chainId?: string | number;
  /** Preformatted balance string (wagmi page only). */
  balance?: string;
}

const SDKS: { key: ShellSdk; label: string; href: string }[] = [
  { key: 'core', label: '@jaw.id/core', href: '/core' },
  { key: 'wagmi', label: '@jaw.id/wagmi', href: '/wagmi' },
];

export function ShellHeader({
  sdk,
  isConnected,
  onToggleConnect,
  address,
  ensName,
  chainId,
  balance,
}: ShellHeaderProps) {
  // Carry ?mode= / ?transport= across the SDK switch so the session shape is kept.
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const withQuery = (href: string) => (query ? `${href}?${query}` : href);

  return (
    <header className="border-shell-line bg-shell-panel flex min-h-[62px] flex-none flex-wrap items-center gap-x-[22px] gap-y-3.5 border-b px-5 py-[11px] max-md:gap-x-3 max-md:px-4">
      {/* Brand → entry */}
      <div className="flex flex-none items-center gap-3 max-sm:gap-2">
        <Link
          href="/"
          title="Back to overview"
          aria-label="Back to overview"
          className="hover:bg-shell-raise-2 -mx-[7px] -my-[5px] flex items-center gap-3 rounded-[10px] px-[7px] py-[5px] transition-colors max-sm:gap-2"
        >
          <Image
            src="/jaw-logo.png"
            alt=""
            width={24}
            height={26}
            className="block max-sm:h-auto max-sm:w-5 dark:brightness-0 dark:invert"
          />
          <span className="text-shell-ink text-[21px] font-semibold tracking-[-0.03em] max-sm:text-[17px]">
            JAW<span className="text-shell-ink-3">.id</span>
          </span>
        </Link>
        <span className="bg-shell-line-2 h-[22px] w-px" />
        <span className="text-shell-ink text-[21px] font-medium tracking-[-0.03em] max-sm:text-[17px]">Playground</span>
      </div>

      <div className="flex-1 max-md:hidden" />

      {/* SDK switch */}
      <div className="relative flex flex-none items-center gap-[9px] max-md:order-2 max-md:basis-full">
        <span className="text-shell-ink-3 text-[13px] max-sm:hidden">SDK</span>
        <SegGroup label="SDK">
          {SDKS.map((s) => (
            <Link
              key={s.key}
              href={withQuery(s.href)}
              className={segClass(sdk === s.key, 'font-mono text-[11.5px] max-sm:px-2.5')}
            >
              {s.label}
            </Link>
          ))}
        </SegGroup>
        <InfoPopover label="What is the difference between the SDKs?">
          <div className="flex flex-col gap-3.5">
            <div>
              <div className="text-shell-core-ink font-mono text-[12.5px] font-semibold">@jaw.id/core</div>
              <p className="text-shell-ink-3 mt-[5px] text-[13px] leading-relaxed">
                Direct EIP-1193 provider access. Call any RPC method yourself, with no framework attached.
              </p>
            </div>
            <div className="bg-shell-line h-px" />
            <div>
              <div className="text-shell-wagmi-ink font-mono text-[12.5px] font-semibold">@jaw.id/wagmi</div>
              <p className="text-shell-ink-3 mt-[5px] text-[13px] leading-relaxed">
                A wagmi connector, so JAW works through the standard wagmi hooks alongside the rest of your app.
              </p>
            </div>
          </div>
        </InfoPopover>
      </div>

      <div className="flex-1 max-md:hidden" />

      {/* Account chips — on mobile they drop to the row below the SDK switch. */}
      {isConnected && (
        <div className="flex flex-none flex-wrap items-center gap-[11px] max-md:order-3">
          {(ensName || address) && (
            <CopyChip
              text={ensName ?? address ?? ''}
              display={ensName ?? (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '')}
            />
          )}
          {balance && <span className="text-shell-ink-3 whitespace-nowrap font-mono text-xs">{balance}</span>}
          {chainId !== undefined && <CopyChip text={String(chainId)} />}
        </div>
      )}

      {/* Connect + theme — on mobile they share the brand row. */}
      <div className="flex flex-none items-center gap-2.5 max-md:order-1 max-md:ml-auto max-md:gap-2">
        <button
          type="button"
          onClick={onToggleConnect}
          className={`text-shell-ink inline-flex flex-none cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border bg-transparent px-3.5 py-[7px] text-[12.5px] font-medium tracking-[-0.005em] transition-colors ${
            isConnected ? 'border-shell-line-2' : 'border-shell-ink-4 hover:border-shell-ink-3'
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-[7px] w-[7px] flex-none rounded-full ${
              isConnected ? 'animate-pulse-dot bg-shell-ok' : 'bg-shell-err'
            }`}
          />
          {isConnected ? 'Disconnect' : 'Connect'}
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}

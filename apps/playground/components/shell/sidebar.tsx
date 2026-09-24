'use client';

import type { ReactNode } from 'react';

export type ShellView = 'playground' | 'theme';

export interface ShellSidebarProps {
  view: ShellView;
  onViewChange: (view: ShellView) => void;
  /** Pill text on the "Dialog Theme" row (active preset name). */
  themeMeta: string;
  /** Pill text on the "Playground" row (method count). */
  methodCount: number;
  /** Below `md`: hide the sidebar while a method detail fills the screen. */
  mobileHidden?: boolean;
  children?: ReactNode;
}

const ThemeIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3.2a8.8 8.8 0 000 17.6c1.5 0 2.4-.9 2.4-2 0-1.2-.9-1.7-.9-2.6 0-.8.7-1.4 1.6-1.4h1.7c2.2 0 4-1.8 4-4.1 0-4.1-4-7.5-8.8-7.5z" />
    <circle cx="8.2" cy="9.4" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.6" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="7.3" cy="13.4" r="1.05" fill="currentColor" stroke="none" />
  </svg>
);

const ListIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 7h16" />
    <path d="M4 12h10" />
    <path d="M4 17h13" />
  </svg>
);

export function ShellSidebar({
  view,
  onViewChange,
  themeMeta,
  methodCount,
  mobileHidden = false,
  children,
}: ShellSidebarProps) {
  const rows: { key: ShellView; label: string; meta: string; icon: ReactNode }[] = [
    { key: 'theme', label: 'Dialog Theme', meta: themeMeta, icon: ThemeIcon },
    { key: 'playground', label: 'Playground', meta: String(methodCount), icon: ListIcon },
  ];

  return (
    <aside
      className={`border-shell-line bg-shell-panel flex min-h-0 flex-col border-r max-md:border-b max-md:border-r-0 ${
        mobileHidden ? 'max-md:hidden' : ''
      }`}
    >
      <nav className="flex flex-col gap-0.5 px-3 pb-3 pt-3.5">
        {rows.map((row) => {
          const active = view === row.key;
          return (
            <button
              key={row.key}
              type="button"
              onClick={() => onViewChange(row.key)}
              className={`flex w-full cursor-pointer items-center justify-between rounded-[10px] border-0 px-[11px] py-[9px] text-[13.5px] font-medium tracking-[-0.01em] transition-colors ${
                active ? 'bg-shell-active text-shell-ink' : 'text-shell-ink-3 hover:bg-shell-raise-2 bg-transparent'
              }`}
            >
              <span className="flex items-center gap-2.5">
                {row.icon}
                {row.label}
              </span>
              <span className="bg-shell-raise-2 text-shell-ink-2 flex-none rounded-full px-[7px] py-0.5 font-mono text-[11px] font-medium">
                {row.meta}
              </span>
            </button>
          );
        })}
      </nav>
      {children}
    </aside>
  );
}

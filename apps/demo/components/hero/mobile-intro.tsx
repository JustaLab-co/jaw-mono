'use client';

import { Icon } from '@/components/ui';
import { MobileIntroBar } from './mobile-bar';
import { SocialApp } from '@/components/screens/social';

const LINKS = [
  {
    href: 'https://dashboard.jaw.id',
    title: 'Dashboard',
    desc: 'Create a workspace and get your API key',
    external: false,
  },
  {
    href: 'https://docs.jaw.id',
    title: 'Docs',
    desc: 'Drop-in SDK, integrate in minutes',
    external: true,
  },
  {
    href: 'https://playground.jaw.id/',
    title: 'Playground',
    desc: 'Test all capabilities and check code snippets',
    external: true,
  },
];

// Mobile-only landing shown before the demo starts. Desktop puts the pitch
// beside the phone; on a real phone the demo owns the whole screen, so this
// page carries the headline, the three capabilities, and the launch CTA first.
export function MobileIntro({ onLaunch, onMenu }: { onLaunch: () => void; onMenu: () => void }) {
  return (
    <div
      className="animate-jd-fade flex h-full flex-col overflow-y-auto bg-white"
      data-analytics-surface="mobile-intro"
    >
      <MobileIntroBar onMenu={onMenu} />

      <div className="px-5 pt-5">
        <h1 className="mb-2.5 text-balance text-[27px] font-semibold leading-[1.08] tracking-[-0.035em]">
          Experience <span className="text-jaw-blue">your users&apos;</span> journey
        </h1>
        <p className="text-ink-2 mb-5 text-pretty text-[14.5px] leading-[1.55]">
          A social feed, a bill split, an AI agent. Three different designs, one invisible SDK, paid in EURe. Every
          action settles onchain.
        </p>
      </div>

      {/* The stage: a mini phone previewing the first demo screen, launch pill
          on top. The preview is the real SocialApp, scaled and inert. */}
      <div className="px-4">
        <div
          className="bg-raise flex justify-center rounded-[24px] px-4 py-6"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(15,23,42,.07) 1px, transparent 0)',
            backgroundSize: '22px 22px',
          }}
        >
          <div onClick={onLaunch} className="relative w-[200px] cursor-pointer">
            <div className="h-[400px] w-[200px] overflow-hidden rounded-[30px] bg-white shadow-[0_28px_56px_-24px_rgba(15,23,42,.4)] ring-1 ring-[rgba(15,23,42,.08)]">
              <div
                aria-hidden
                inert
                className="pointer-events-none origin-top-left select-none"
                style={{ width: 360, height: 720, transform: 'scale(0.5556)' }}
              >
                <SocialApp onCta={() => {}} />
              </div>
              {/* Soften the preview so the launch pill owns the focus. */}
              <div className="absolute inset-0 bg-white/45" />
            </div>
            <button
              type="button"
              onClick={onLaunch}
              className="bg-ink absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full px-6 py-3.5 text-[15px] font-semibold tracking-[-0.01em] text-white shadow-[0_16px_32px_-12px_rgba(15,23,42,.6)] transition-transform duration-150 active:scale-[.97]"
            >
              Launch demo <Icon.Arrow size={14} />
            </button>
          </div>
        </div>

        <div className="flex justify-center py-4">
          <span className="border-line text-ink-2 inline-flex items-center gap-[7px] rounded-full border bg-white px-3.5 py-[7px] font-mono text-[9px] uppercase tracking-[.14em]">
            <span className="bg-jaw-blue h-[5px] w-[5px] rounded-full" />
            Many capabilities, one account
          </span>
        </div>

        <nav aria-label="Next steps" className="border-line divide-line mb-8 divide-y rounded-[18px] border">
          {LINKS.map((l) => (
            <a
              key={l.title}
              href={l.href}
              {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="active:bg-raise flex items-center gap-3 px-4 py-3.5 text-inherit no-underline transition-colors duration-150 first:rounded-t-[18px] last:rounded-b-[18px]"
            >
              <span className="min-w-0">
                <span className="text-ink block text-[15px] font-semibold leading-[1.3] tracking-[-0.015em]">
                  {l.title}
                </span>
                <span className="text-ink-3 block truncate text-[12.5px] leading-[1.5]">{l.desc}</span>
              </span>
              <span className="border-line-2 text-ink-2 ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-full border">
                {l.external ? <Icon.ArrowUR size={11} /> : <Icon.Arrow size={12} />}
              </span>
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

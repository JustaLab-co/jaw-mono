'use client';

import { Icon } from '@/components/ui';

// Delayed fade for the sheet's children: they appear together once the sheet
// has slid up.
const finFade = 'animate-hd-fin-fade [animation-delay:220ms]';

// Finale sheet shown inside the phone after the last feature completes.
export function FinSheet({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="absolute inset-0 z-[60] flex items-end" data-analytics-surface="finale">
      <div className="animate-hd-fin-fade absolute inset-0 bg-[rgba(15,23,42,.4)] backdrop-blur-[3px]" />
      <div className="animate-hd-fin-up relative w-full rounded-t-[26px] bg-white px-6 pb-[34px] pt-[26px] text-center shadow-[0_-24px_60px_-24px_rgba(15,23,42,.5)]">
        <span className={`bg-line-2 mx-auto mb-5 block h-[5px] w-[38px] rounded-full ${finFade}`} />
        <span
          className={`text-jaw-blue mx-auto mb-4 grid h-[52px] w-[52px] place-items-center rounded-full bg-[#EEF3FF] ${finFade}`}
        >
          <Icon.Logo size={24} />
        </span>
        <div className={`mb-[7px] text-[20px] font-semibold tracking-[-0.025em] ${finFade}`}>Now build yours</div>
        <p className={`text-ink-2 mx-auto mb-[22px] max-w-[250px] text-[13.5px] leading-[1.55] ${finFade}`}>
          Onboarding, payments, agent permissions. Embedded and self-custodial, in your design, under your brand.
        </p>
        <div className={`flex flex-col gap-[9px] ${finFade}`}>
          <a
            href="https://dashboard.jaw.id"
            className="bg-ink flex items-center justify-center gap-2 rounded-[14px] px-[18px] py-3.5 text-[15px] font-semibold tracking-[-0.01em] text-white no-underline transition-transform duration-150 hover:-translate-y-px"
          >
            Dashboard <Icon.Arrow size={14} />
          </a>
          <a
            href="https://playground.jaw.id/"
            target="_blank"
            rel="noopener noreferrer"
            className="border-line-2 text-ink flex items-center justify-center gap-2 rounded-[14px] border px-[18px] py-3.5 text-[15px] font-semibold tracking-[-0.01em] no-underline transition-transform duration-150 hover:-translate-y-px"
          >
            See the playground <Icon.ArrowUR size={12} />
          </a>
        </div>
        <button
          type="button"
          onClick={onRestart}
          className={`text-ink-2 hover:bg-raise-2 hover:text-ink mt-3.5 flex w-full cursor-pointer items-center justify-center gap-[7px] rounded-xl px-3.5 py-2.5 text-[14px] font-medium transition-colors duration-[180ms] ${finFade}`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          Run the flows again
        </button>
      </div>
    </div>
  );
}

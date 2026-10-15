'use client';

import { ctaInteract } from './common';
import { Icon } from '@/components/ui';

// Green "ox" Agens palette from the copy-edit design (Screen dark="ox").
const shell = '#0C2721';
const chat = '#10312A';
const bubble = '#18443B';
const mint = '#5FE0A0';
const inkOnMint = '#062018';
const tint = 'rgba(224,248,238,.5)';

// "Agens": deep-green AI-agent chat asking for a spending permission.
export function AgentApp({ onCta }: { onCta: () => void }) {
  return (
    <div className="flex h-full flex-col overflow-hidden font-sans text-[#EAF7F1]" style={{ background: shell }}>
      {/* pt clears the frame's drawn status bar; on a phone the tour's own top
          bar sits there instead, so mobile only needs normal header padding. */}
      <div className="flex items-center gap-2.5 border-b border-white/10 px-5 pb-3 pt-[70px] max-md:pt-4">
        <span
          className="relative grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full text-[14px] font-bold text-white"
          style={{ background: 'linear-gradient(135deg,#1F6B58,#4FC79F)' }}
        >
          A
          <span
            className="absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full"
            style={{ background: '#10B981', border: `2px solid ${shell}` }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-[650]">Agens</div>
          <div className="font-mono text-[10px]" style={{ color: tint }}>
            agens.justan.id · online
          </div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={tint} strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
          <circle cx="5" cy="12" r="1" />
        </svg>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-2.5 px-[18px] py-4" style={{ background: chat }}>
        <div className="mb-0.5 text-center font-mono text-[9.5px] tracking-[.08em] text-[rgba(224,248,238,.35)]">
          TODAY · 9:41 AM
        </div>
        <div
          className="max-w-[82%] self-end rounded-[16px_16px_4px_16px] px-3.5 py-2.5 text-[13.5px] leading-normal"
          style={{ background: mint, color: inkOnMint }}
        >
          Watch the market dataset and buy it whenever it drops under $2.
        </div>
        <div
          className="max-w-[86%] self-start rounded-[16px_16px_16px_4px] border border-white/10 px-3.5 py-2.5 text-[13.5px] leading-normal"
          style={{ background: bubble }}
        >
          On it. I&apos;ll check <span className="font-mono text-[12px]">api.dataprovider.eth</span> every hour and buy
          when the price crosses.
        </div>
        <div
          className="max-w-[86%] self-start rounded-[16px_16px_16px_4px] border border-white/10 px-3.5 py-3 text-[13.5px] leading-normal"
          style={{ background: bubble }}
        >
          To pay for it, I need a spending permission:
          <div className="mb-0.5 mt-2.5 flex flex-col gap-[5px] rounded-[10px] border border-white/10 bg-black/25 px-3 py-2.5">
            {(
              [
                ['Scope', 'EURe + ETH spends'],
                ['EURe cap', '25 / day'],
                ['ETH cap', '0.01 / month'],
                ['Expires', 'in 30 days'],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between text-[11.5px]">
                <span style={{ color: tint }}>{k}</span>
                <span className="font-mono text-[10.5px] font-semibold">{v}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={onCta}
            className={`mt-[11px] flex w-full cursor-pointer items-center justify-center gap-[7px] rounded-[10px] bg-white px-4 py-[11px] text-[13.5px] font-semibold ${ctaInteract}`}
            style={{ color: inkOnMint }}
          >
            Delegate to agent <Icon.Arrow size={13} />
          </button>
        </div>
      </div>
      <div className="border-t border-white/10 px-[18px] py-3" style={{ background: shell }}>
        <div className="flex items-center gap-2.5 rounded-full bg-white/[.07] px-3.5 py-[9px] text-[13px] text-[rgba(224,248,238,.45)]">
          Message Agens…
          <svg
            className="ml-auto"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m22 2-7 20-4-9-9-4Z" />
            <path d="M22 2 11 13" />
          </svg>
        </div>
        <div className="h-[34px] max-md:hidden" />
      </div>
    </div>
  );
}

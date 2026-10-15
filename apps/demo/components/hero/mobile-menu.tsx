'use client';

import { FEATS } from './features';
import { btnGhost, btnPrimary, Icon } from '@/components/ui';

// Mobile-only feature switcher: the bottom sheet listing every feature, its
// variants, and the links that live in the desktop header/footer. The trigger
// lives in the top bar (see mobile-bar.tsx).
export function MobileMenu({
  open,
  onClose,
  activeId,
  activeVi,
  onPick,
  onPickVariant,
}: {
  open: boolean;
  onClose: () => void;
  activeId: number;
  activeVi: number;
  onPick: (id: number) => void;
  onPickVariant: (id: number, vi: number) => void;
}) {
  return (
    <>
      {open && (
        <div
          className="animate-jd-fade absolute inset-0 z-[55] flex items-end bg-[rgba(15,23,42,.35)] backdrop-blur-[2px] md:hidden"
          onClick={onClose}
          data-analytics-surface="mobile-menu"
        >
          <div
            className="max-h-[86%] w-full overflow-y-auto rounded-t-[26px] bg-white px-4 pb-9 pt-2"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="bg-line-2 mx-auto mb-4 block h-[5px] w-[38px] rounded-full" />
            <div className="text-ink-3 mb-3 px-1 font-mono text-[10px] uppercase tracking-[.12em]">
              Walk through what your users do
            </div>
            <div className="flex flex-col gap-2">
              {FEATS.map((f) => {
                const on = activeId === f.id;
                return (
                  // Row selection rides the title button's stretched ::after
                  // (a native button handles Enter AND Space), keeping the
                  // variant pill <button>s out of any button-role ancestor —
                  // they sit z-raised above the overlay.
                  <div
                    key={f.id}
                    className={`relative rounded-xl border px-3.5 py-3 transition-colors duration-200 ${
                      on ? 'border-ink shadow-[0_1px_0_var(--ink)]' : 'border-line'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`font-mono text-[11px] font-semibold ${on ? 'text-jaw-blue' : 'text-ink-3'}`}>
                        {String(f.id).padStart(2, '0')}
                      </span>
                      <button
                        type="button"
                        onClick={() => onPick(f.id)}
                        className={`cursor-pointer text-[15px] tracking-[-0.01em] after:absolute after:inset-0 after:cursor-pointer after:content-[''] ${
                          on ? 'font-semibold' : 'text-ink-2 font-medium'
                        }`}
                      >
                        {f.title}
                      </button>
                    </div>
                    <div className="text-ink-3 mt-1 pl-[26px] text-[12px]">{f.teaser}</div>
                    {f.variants.length > 1 && (
                      <div className="relative z-[1] mt-2 flex flex-wrap gap-1.5 pl-[26px]">
                        {f.variants.map((fv, i) => {
                          const vOn = on && i === activeVi;
                          return (
                            <button
                              key={fv.key}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onPickVariant(f.id, i);
                              }}
                              className={`cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[.08em] ${
                                vOn
                                  ? 'border-jaw-blue text-jaw-blue bg-[rgba(8,81,255,.06)]'
                                  : 'border-line-2 text-ink-3'
                              }`}
                            >
                              {fv.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <a
              href="https://playground.jaw.id/"
              target="_blank"
              rel="noopener noreferrer"
              className="border-line text-ink-3 mt-2 flex items-center justify-between rounded-xl border px-3.5 py-3 text-[14px] font-medium no-underline"
            >
              Run it yourself
              <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[.1em]">
                Playground <Icon.ArrowUR size={10} />
              </span>
            </a>
            <a
              href="https://jaw.id"
              className="border-line text-ink-3 mt-2 flex items-center justify-between rounded-xl border px-3.5 py-3 text-[14px] font-medium no-underline"
            >
              Back to website
              <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[.1em]">
                jaw.id
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 12H5" />
                  <path d="m12 19-7-7 7-7" />
                </svg>
              </span>
            </a>
            <div className="mt-4 flex gap-2">
              <a href="https://dashboard.jaw.id" className={`${btnPrimary} flex-1`}>
                Dashboard <Icon.Arrow size={12} />
              </a>
              <a href="https://docs.jaw.id" target="_blank" rel="noopener noreferrer" className={btnGhost}>
                Docs <Icon.ArrowUR size={11} />
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

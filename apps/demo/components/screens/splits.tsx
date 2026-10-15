'use client';

import { Icon } from '@/components/ui';
import { ctaInteract } from './common';

const cream = '#F4F5F7';
const navy = '#16233F';
const red = '#C81E33';
const green = '#1E7A45';
const gold = '#C29A34';

function Row({
  name,
  slips,
  amt,
  c1,
  c2,
  ini,
  photo,
  on = true,
}: {
  name: string;
  slips: string;
  amt: string;
  c1: string;
  c2: string;
  ini: string;
  photo: string;
  on?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-xl bg-white px-[13px] py-2"
      style={{ border: '1.5px solid rgba(22,35,63,.18)' }}
    >
      <span
        className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] text-white"
        style={{ background: on ? navy : '#fff', border: on ? 'none' : '1.5px solid rgba(22,35,63,.25)' }}
      >
        {on && <Icon.Check size={10} />}
      </span>
      <span
        className="relative grid h-[34px] w-[34px] shrink-0 place-items-center overflow-hidden rounded-full text-[12.5px] font-semibold text-white"
        style={{ background: `linear-gradient(135deg,${c1},${c2})` }}
      >
        {ini}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover" />
      </span>
      <span className="min-w-0">
        <span className="block whitespace-nowrap text-[14px] font-[650] tracking-[-0.01em]" style={{ color: navy }}>
          {name}
        </span>
        <span className="block text-[11px] text-[#8A90A0]">{slips}</span>
      </span>
      <span
        className="font-display ml-auto shrink-0 whitespace-nowrap pl-1.5 text-[15px] font-bold"
        style={{ color: red }}
      >
        {amt}
      </span>
    </div>
  );
}

// Bill splitter: settle up sheet.
export function SplitsApp({ onCta }: { onCta: () => void }) {
  return (
    <div className="relative h-full overflow-hidden font-sans" style={{ background: cream, color: navy }}>
      {/* pt clears the frame's drawn status bar; on a phone the tour's own top
          bar sits there instead, so mobile only needs normal header padding. */}
      <div className="absolute inset-x-0 top-0 px-[18px] pt-[52px] opacity-[.34] max-md:pt-3.5">
        <div className="flex items-center gap-3 border-b border-[rgba(22,35,63,.18)] pb-3">
          <span
            className="relative grid h-[30px] w-[30px] shrink-0 place-items-center overflow-hidden rounded-full text-[11.5px] font-semibold text-white"
            style={{ background: 'linear-gradient(135deg,#7FA3C9,#2F5D8C)' }}
          >
            YB
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://randomuser.me/api/portraits/men/86.jpg"
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          </span>
          <span className="font-display flex-1 text-center text-[23px] font-bold tracking-[-0.01em]">Splitos.eth</span>
          <span className="grid h-[30px] w-[30px] shrink-0 place-items-center" style={{ color: navy }}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </svg>
          </span>
        </div>
        <div className="mb-2 mt-[11px] grid grid-cols-2 gap-2.5">
          {(
            [
              ['YOU OWE', '€72.50', red, 'm7 17 10-10', 'M17 7v10H7'],
              ['OWED TO YOU', '€24.00', green, 'M17 7 7 17', 'M7 7v10h10'],
            ] as const
          ).map(([k, v, col, p1, p2]) => (
            <div key={k} className="rounded-[14px] border border-[rgba(22,35,63,.2)] px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[9.5px] font-bold tracking-[.1em] text-[#5A6379]">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={col}
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={p1} />
                  <path d={p2} />
                </svg>
                {k}
              </div>
              <div className="font-display mt-1.5 text-[23px] font-bold tracking-[-0.01em]" style={{ color: col }}>
                {v}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-[rgba(194,154,52,.5)] bg-[rgba(194,154,52,.07)] px-3 py-2.5">
          <span
            className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9.5px] font-bold"
            style={{ border: '1px solid ' + gold, color: gold }}
          >
            i
          </span>
          <span className="text-[12px] font-[650]">1 slip to confirm</span>
        </div>
      </div>
      <div
        className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-[22px] bg-white"
        style={{ boxShadow: '0 -18px 40px -20px rgba(22,35,63,.35)' }}
      >
        <div className="pt-[7px]">
          <span className="mx-auto block h-[5px] w-11 rounded-full bg-[rgba(22,35,63,.16)]" />
        </div>
        <div className="flex items-center justify-between border-b border-[rgba(22,35,63,.1)] px-[18px] pb-[11px] pt-2.5">
          <span className="font-display text-[23px] font-bold tracking-[-0.01em]">Settle Up</span>
          <span
            className="grid h-[30px] w-[30px] place-items-center rounded-full border border-[rgba(22,35,63,.15)]"
            style={{ color: navy }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </span>
        </div>
        <div className="px-[18px] pb-2 pt-[9px]">
          <div
            className="rounded-2xl border border-[rgba(22,35,63,.12)] px-4 pb-2 pt-[9px] text-center"
            style={{ background: 'linear-gradient(180deg,#F7F8FA,#FFFFFF)' }}
          >
            <div className="text-[9.5px] font-bold tracking-[.16em] text-[#6B7385]">TOTAL TO SETTLE</div>
            <div
              className="font-display mt-[3px] flex items-baseline justify-center gap-0.5 tracking-[-0.015em]"
              style={{ color: red }}
            >
              <span className="mt-1 self-start text-[18px] font-semibold">€</span>
              <span className="text-[34px] font-bold leading-[1.05]">72</span>
              <span className="text-[20px] font-semibold opacity-55">.50</span>
            </div>
            <div className="mt-1.5 flex items-center justify-center gap-2 whitespace-nowrap text-[10.5px] text-[#7A8194]">
              <span>3 people</span>
              <span className="h-[3px] w-[3px] rounded-full bg-[rgba(22,35,63,.22)]" />
              <span>4 slips</span>
              <span className="h-[3px] w-[3px] rounded-full bg-[rgba(22,35,63,.22)]" />
              <span>EURe</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2.5 px-[18px] pb-2">
          <span className="whitespace-nowrap text-[10px] font-bold tracking-[.14em] text-[#5A6379]">
            SELECT WHO TO PAY
          </span>
          <span className="h-px flex-1 bg-[rgba(22,35,63,.12)]" />
        </div>
        <div className="flex flex-col gap-[7px] px-[18px] pb-2.5">
          <Row
            name="John Carter"
            slips="1 slip"
            amt="€42.50"
            c1="#64748B"
            c2="#334155"
            ini="KN"
            photo="https://randomuser.me/api/portraits/men/32.jpg"
          />
          <Row
            name="Sarah Park"
            slips="1 slip"
            amt="€18.00"
            c1="#E4677B"
            c2="#B91C3C"
            ini="SK"
            photo="https://randomuser.me/api/portraits/women/44.jpg"
          />
          <Row
            name="Youssef Bahri"
            slips="2 slips"
            amt="€12.00"
            c1="#7FA3C9"
            c2="#2F5D8C"
            ini="YB"
            photo="https://randomuser.me/api/portraits/men/75.jpg"
          />
        </div>
        <div className="grid grid-cols-2 gap-2.5 border-t border-[rgba(22,35,63,.1)] px-[18px] pb-11 pt-3">
          <span
            className="flex items-center justify-center gap-[7px] whitespace-nowrap rounded-[14px] border border-[rgba(22,35,63,.18)] px-2.5 py-[15px] text-[16px] font-semibold tracking-[-0.01em]"
            style={{ color: navy }}
          >
            Pay selected
          </span>
          <button
            type="button"
            onClick={onCta}
            className={`flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[14px] px-3 py-[15px] text-[16px] font-semibold tracking-[-0.01em] text-white ${ctaInteract}`}
            style={{ background: gold, boxShadow: '0 12px 28px -12px rgba(194,154,52,.85)' }}
          >
            Settle All <Icon.Arrow size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

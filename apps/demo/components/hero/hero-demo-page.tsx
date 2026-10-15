'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FEATS, type Feat, type PhoneAppKey, type Variant } from './features';
import { FeatRow } from './feature-row';
import { SiteHeader } from './site-header';
import { MobileMenu } from './mobile-menu';
import { MobileTourBar } from './mobile-bar';
import { MobileIntro } from './mobile-intro';
import { FundingOverlay } from './funding-overlay';
import { fundAccount } from '@/lib/funding';
import { FinSheet } from './fin-sheet';
import { IOS_BEZEL, IOS_RADIUS, IOSDevice } from '@/components/ios-device';
import { btnGhost, btnPrimary, Icon } from '@/components/ui';
import { SocialApp } from '@/components/screens/social';
import { DEMO_CHAIN_ID, getJaw, prewarmJaw, resetJaw, transportMode } from '@/lib/jaw';
import { getAnalyticsClient } from '@/lib/analytics';
import type { FeatureContext, SurfaceName } from '@/lib/analytics/events/types';
import { featureRequest } from '@/lib/requests';
import { useDialogEmbed } from '@/lib/use-dialog-embed';
import { SplitsApp } from '@/components/screens/splits';
import { AgentApp } from '@/components/screens/agent';

type BaseAppProps = { onCta: () => void };

const BASE_APPS: Record<PhoneAppKey, (props: BaseAppProps) => React.ReactElement> = {
  social: ({ onCta }) => <SocialApp onCta={onCta} />,
  splits: ({ onCta }) => <SplitsApp onCta={onCta} />,
  agent: ({ onCta }) => <AgentApp onCta={onCta} />,
};

// Screen size of the mock phone at rest; the rendered frame adds the bezel.
// Both are responsive — see usePhoneFit — and the pair holds the original
// 360x700 proportion (660 / 340 = 1.94) at every size, so shrinking the window
// never leaves the phone stubby.
const PW_MAX = 340;
const PH_MAX = 660;
const ASPECT = PH_MAX / PW_MAX;
// Narrowest the screen may get. Below 300px the mock app screens and the real
// keys dialog start to crowd, so the phone stops shrinking and the page scrolls
// instead. The height floor follows from it, keeping the ratio exact.
const PW_MIN = 300;
const PH_MIN = Math.round(PW_MIN * ASPECT);
// Scale is measured against the widest the frame can ever be, so it depends
// only on the column width. Deriving it from the live width would couple it to
// the height it feeds, and the two would chase each other on resize.
const FRAME_W_MAX = PW_MAX + IOS_BEZEL * 2;
// Cap at 1 (native size) so text never upscales blurry; otherwise fill the container.
const MAX_SCALE = 1;
const MIN_SCALE = 0.45;
// Stage padding below the phone. Kept tight so the phone holds PH_MAX until the
// window really is too short — a larger gap makes it shrink while space remains.
const STAGE_GAP = 24;

// Fit the phone to its container width and the window height.
function usePhoneFit() {
  const areaRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(MAX_SCALE);
  const [phoneH, setPhoneH] = useState(PH_MAX);
  const [phoneW, setPhoneW] = useState(PW_MAX);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    // Width drives the transform; height is answered by resizing the phone for
    // real, not by scaling it down. The embedded keys iframe renders at native
    // pixels (it cannot be transform-scaled without tripping keys' visibility
    // guard), so a height shrink via transform would make the real dialog look
    // oversized next to the mock app. Changing the screen height instead keeps
    // the phone at 1:1 while still fitting a non-maximised window.
    const measure = () => {
      const byWidth = el.clientWidth / FRAME_W_MAX;
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, byWidth));
      setScale(next);
      const avail = (window.innerHeight - el.getBoundingClientRect().top - STAGE_GAP) / next;
      const h = Math.round(Math.max(PH_MIN, Math.min(PH_MAX, avail - IOS_BEZEL * 2)));
      setPhoneH(h);
      // Width follows height so the proportion is fixed, not just the rest size.
      setPhoneW(Math.round(h / ASPECT));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return { areaRef, scale, phoneH, phoneW };
}

// On phones the visitor's device IS the phone: render the demo full-bleed,
// no frame. Matches Tailwind's md breakpoint.
function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return mobile;
}

// Features without a theme of their own reset the dialog to the SDK's light
// defaults, so a themed feature never leaks its palette into the next screen.
const DEFAULT_THEME = { mode: 'light' } as const;

// Analytics context for the screen an event belongs to. Captured at the start
// of an async flow so a request resolving after a navigation still reports the
// feature it was fired from.
const featureCtx = (feat: Feat, variant: Variant): FeatureContext => ({
  feature: feat.analytics,
  featureId: feat.id,
  variant: variant.key,
});

const errMessage = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Unknown error');

// WALLET_CONNECTED is the same event name and shape playground fires, so
// "connected a JAW account" is ONE funnel across both apps — the `app`
// super-property says which one it happened in.
const trackConnected = (analytics: ReturnType<typeof getAnalyticsClient>) =>
  analytics.track('WALLET_CONNECTED', {
    sdk: 'core',
    mode: 'cross-platform',
    transportMode: transportMode(),
    chainId: DEMO_CHAIN_ID,
  });

export function HeroDemoPage() {
  const [id, setId] = useState(1);
  const [vi, setVi] = useState(0);
  const [open, setOpen] = useState(false);
  const [fin, setFin] = useState(false);
  const [menu, setMenu] = useState(false);
  // Non-cancel failure of the last wallet request (missing funds, dead RPC…),
  // surfaced as an inline banner on the phone screen.
  const [err, setErr] = useState<string | null>(null);
  // Mobile-only: the intro page is shown until the visitor launches the demo.
  // Desktop always renders the demo — its pitch lives beside the phone.
  const [started, setStarted] = useState(false);
  // Post-sign-up hold while /api/fund tops the account up with testnet EURe.
  const [funding, setFunding] = useState(false);
  const { areaRef, scale, phoneH, phoneW } = usePhoneFit();
  const frameH = phoneH + IOS_BEZEL * 2;
  const frameW = phoneW + IOS_BEZEL * 2;
  const isMobile = useIsMobile();
  // `isMobile` is resolved in an effect (SSR can't know the viewport), so hold
  // the first analytics event until after mount — otherwise the opening event
  // of every mobile session is mislabelled `desktop`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const surface: SurfaceName = isMobile ? 'mobile' : 'desktop';
  // Elements the real keys.jaw.id dialog gets pinned to: the phone screen on
  // desktop, the full-bleed demo area on mobile.
  const [mobileEl, setMobileEl] = useState<HTMLDivElement | null>(null);
  const [screenEl, setScreenEl] = useState<HTMLDivElement | null>(null);
  useDialogEmbed(isMobile ? mobileEl : screenEl, isMobile ? 0 : IOS_RADIUS * scale, open);
  const cur = FEATS.find((f) => f.id === id) ?? FEATS[0];
  // Latest feature for async callbacks that may outlive a navigation.
  const curRef = useRef(cur);
  curRef.current = cur;
  useEffect(() => {
    // Prewarm mounts the hidden keys iframe; the active feature's theme rides
    // the handshake on first load and a live SetTheme push on every switch.
    const provider = prewarmJaw();
    provider?.setTheme(cur.theme ?? DEFAULT_THEME);
  }, [cur]);

  useEffect(() => {
    // Sign in / Sign up always demos a fresh connect. Log out on ENTERING the
    // screen (not on tap): disconnect tears the keys iframe down, and doing it
    // here lets a fresh one prewarm in the background while the user reads the
    // screen — so the tap itself opens the drawer with no teardown lag.
    if (cur.id !== 1) return;
    let cancelled = false;
    (async () => {
      const jaw = getJaw();
      if (!jaw) return;
      const accounts = (await jaw.provider.request({ method: 'eth_accounts' })) as string[];
      // If the user already moved to another screen, keep their session —
      // the logout is only owed while Sign up is actually in front of them.
      if (cancelled) return;
      if (accounts && accounts.length > 0) {
        await jaw.provider.disconnect();
        // The teardown happened; rebuild + theme for wherever the user is NOW.
        const active = curRef.current;
        resetJaw()?.provider.setTheme(active.theme ?? DEFAULT_THEME);
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cur]);

  const v = cur.variants[vi] ?? cur.variants[0];

  useEffect(() => {
    // On mobile nothing is on screen until the visitor launches the demo; on
    // desktop the phone is always visible, so the first feature counts as seen.
    if (!mounted || (isMobile && !started)) return;
    getAnalyticsClient().track('DEMO_FEATURE_VIEWED', {
      feature: cur.analytics,
      featureId: cur.id,
      variant: v.key,
      surface,
    });
  }, [mounted, isMobile, started, surface, cur, v]);

  // Epoch for in-flight wallet requests: bumped on every navigation so a
  // request resolving after the user moved on can no longer advance the tour.
  const runRef = useRef(0);
  const pick = (n: number) => {
    runRef.current++;
    setId(n);
    setVi(0);
    setOpen(false);
    setFin(false);
    setMenu(false);
    setErr(null);
  };
  const pickVariant = (i: number) => {
    const picked = cur.variants[i];
    // Only the deliberate toggle in the feature list lands here.
    if (picked) {
      getAnalyticsClient().track('DEMO_VARIANT_SELECTED', {
        feature: cur.analytics,
        featureId: cur.id,
        variant: picked.key,
      });
    }
    runRef.current++;
    setVi(i);
    setOpen(false);
    setErr(null);
  };
  // From the in-phone menu: jump straight to a feature + variant.
  const pickFeatVariant = (n: number, i: number) => {
    runRef.current++;
    setId(n);
    setVi(i);
    setOpen(false);
    setFin(false);
    setMenu(false);
    setErr(null);
  };
  // Mobile only: the intro fronts the tour until the visitor launches it, from
  // the CTA or by picking a capability out of the menu.
  const launchMobile = () => {
    getAnalyticsClient().track('DEMO_LAUNCHED', { surface: 'mobile' });
    setStarted(true);
  };
  // Bar controls. Exit drops back to the intro with the tour rewound; skip
  // moves to the next capability WITHOUT running its request, so it never
  // counts as completing the tour.
  const exitDemo = () => {
    pick(1);
    setStarted(false);
  };
  const skipNext = () => {
    const next = FEATS[FEATS.findIndex((f) => f.id === cur.id) + 1];
    if (next) pick(next.id);
  };
  const advanceFrom = (fromId: number) => {
    // Advance by list position, not id arithmetic — ids are not guaranteed to
    // stay contiguous with the list.
    const next = FEATS[FEATS.findIndex((f) => f.id === fromId) + 1];
    if (next) {
      pick(next.id);
    } else {
      setOpen(false);
      setFin(true);
      getAnalyticsClient().track('DEMO_COMPLETED', { surface });
    }
  };
  const Base = BASE_APPS[v.app || cur.app];
  // The Agens screen is dark: flip the status bar / home indicator.
  const darkScreen = (v.app || cur.app) === 'agent';

  // Every CTA opens the real keys.jaw.id dialog (contained in the phone), and
  // each feature runs a genuine request.
  const onCta = async () => {
    // One request at a time: the CTA stays clickable until the dialog paints,
    // so a double-tap must not fire two wallet requests.
    if (open) return;
    const jaw = getJaw();
    if (!jaw) return;
    const run = ++runRef.current;
    const fromId = cur.id;
    // Snapshot the screen this action started on: the request can outlive a
    // navigation and must still report the feature that fired it.
    const analytics = getAnalyticsClient();
    const ctx = featureCtx(cur, v);
    analytics.track('DEMO_ACTION_STARTED', ctx);
    setErr(null);
    setOpen(true);
    try {
      // eth_accounts is silent + local: it reports the live session without
      // opening the dialog.
      const accounts = (await jaw.provider.request({ method: 'eth_accounts' })) as string[];
      const connected = Boolean(accounts && accounts.length > 0);
      if (cur.id === 1) {
        // Fresh-connect demo. The screen-entry effect normally logged out
        // already; the disconnect here only covers taps that raced it.
        if (connected) {
          await jaw.provider.disconnect();
          resetJaw()?.provider.setTheme(cur.theme ?? DEFAULT_THEME);
        }
        // A plain connect: onboarding creates the account and signs the user in.
        await getJaw()!.provider.request({ method: 'eth_requestAccounts' });
        trackConnected(analytics);
        // Fund the fresh account with testnet EURe so the send feature
        // actually settles. The route skips accounts that already
        // hold enough; a failure surfaces as the inline error banner (the
        // outer catch) and keeps the user on this screen.
        const funded = (await jaw.provider.request({ method: 'eth_accounts' })) as string[];
        if (funded?.[0]) {
          analytics.identify(funded[0]);
          if (runRef.current === run) setFunding(true);
          try {
            const funding = await fundAccount(funded[0]);
            analytics.track('DEMO_FUNDING_SETTLED', { outcome: funding.skipped ? 'skipped' : 'funded' });
          } catch (e) {
            // Rethrown: funding is the demo's one server dependency and a
            // failure still belongs in the inline banner. Tracked separately
            // because "the tour broke at the funding step" and "the wallet
            // request failed" need telling apart.
            analytics.track('DEMO_FUNDING_FAILED', { message: errMessage(e) });
            throw e;
          } finally {
            setFunding(false);
          }
        }
      } else {
        // Other screens reuse the session; connect only if there is none.
        if (!connected) {
          await jaw.provider.request({ method: 'eth_requestAccounts' });
          trackConnected(analytics);
        }
        const addrs = (await jaw.provider.request({ method: 'eth_accounts' })) as string[];
        if (addrs?.[0]) analytics.identify(addrs[0]);
        await featureRequest(jaw.provider, cur.id);
      }
      analytics.track('DEMO_ACTION_COMPLETED', ctx);
      // Only advance if the user hasn't navigated while the request ran.
      if (runRef.current === run) advanceFrom(fromId);
    } catch (e) {
      console.error('[demo] wallet request failed', e);
      // EIP-1193 4001 = the user dismissed/rejected the dialog — that is a
      // normal path, stay silent. Everything else (unfunded account, missing
      // API key, paymaster rejection…) gets an inline banner.
      const code = (e as { code?: number } | null)?.code;
      if (code === 4001) {
        analytics.track('DEMO_ACTION_REJECTED', ctx);
      } else {
        analytics.track('DEMO_ACTION_FAILED', { ...ctx, code, message: errMessage(e) });
      }
      if (code !== 4001 && runRef.current === run) {
        setErr(e instanceof Error && e.message ? e.message : 'The wallet request failed. See the console for details.');
      }
    } finally {
      setOpen(false);
    }
  };

  // The demo itself: the fake app plus every overlay (menu, dialog, finale).
  // Rendered once — inside the device frame on desktop, full-bleed on mobile.
  const demo = (
    <div className="animate-jd-fade relative flex h-full flex-col" key={`${id}-${v.key}`}>
      {/* Mobile-only app chrome, from the design's .hdm-bar: exit, step
          counter, the capability on screen, skip ahead, menu. It sits IN the
          flow (the app takes what's left) rather than floating over the app,
          and hides by visibility instead of unmounting — dropping it would
          reflow the app underneath every time a dialog opens. */}
      <MobileTourBar
        step={cur.id}
        total={FEATS.length}
        title={cur.title}
        hidden={open || fin}
        atLast={cur.id === FEATS[FEATS.length - 1]?.id}
        onExit={exitDemo}
        onNext={skipNext}
        onMenu={() => setMenu(true)}
      />

      <div className="group/stage min-h-0 flex-1" data-pulse={open || fin || menu ? undefined : ''}>
        <Base onCta={onCta} />
      </div>

      <MobileMenu
        open={menu}
        onClose={() => setMenu(false)}
        activeId={id}
        activeVi={vi}
        onPick={pick}
        onPickVariant={pickFeatVariant}
      />

      {fin && (
        <FinSheet
          onRestart={() => {
            getAnalyticsClient().track('DEMO_RESTARTED', { surface });
            pick(1);
          }}
        />
      )}

      {funding && <FundingOverlay />}

      {err && !open && (
        <div
          role="alert"
          className="animate-jd-fade border-red-line bg-red-bg text-red absolute inset-x-3 top-14 z-[70] flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 shadow-[0_10px_28px_-14px_rgba(15,23,42,.45)]"
        >
          <span className="min-w-0 flex-1 break-words text-[12.5px] font-medium leading-[1.45]">{err}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setErr(null)}
            className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full text-[13px] leading-none hover:bg-[rgba(15,23,42,.08)]"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col max-md:h-dvh max-md:min-h-0">
      {/* desktop-only header; on mobile the demo owns the whole screen and
          brand/back-link live in the hamburger menu */}
      <SiteHeader />

      {/* mobile: the visitor's phone IS the device — demo runs full-bleed, no
          frame. The intro page fronts it; the keys iframe prewarms while the
          visitor reads, so launching opens the first dialog with no lag. */}
      <div ref={setMobileEl} className="relative min-h-0 flex-1 overflow-hidden bg-white md:hidden">
        {isMobile &&
          (started ? (
            demo
          ) : (
            <>
              <MobileIntro onLaunch={launchMobile} onMenu={() => setMenu(true)} />
              {/* Same sheet the tour uses; picking a capability here launches
                  the tour on that screen. */}
              <MobileMenu
                open={menu}
                onClose={() => setMenu(false)}
                activeId={id}
                activeVi={vi}
                onPick={(n) => {
                  launchMobile();
                  pick(n);
                }}
                onPickVariant={(n, i) => {
                  launchMobile();
                  pickFeatVariant(n, i);
                }}
              />
            </>
          ))}
      </div>

      {/* desktop / tablet: framed phone on the stage */}
      <main className="mx-auto grid w-full max-w-[1400px] flex-1 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] items-start max-[1040px]:grid-cols-1 max-md:hidden">
        <div className="flex min-h-0 flex-col justify-start py-[26px] pb-10 pl-9 pr-16 max-[1040px]:px-6">
          <h1 className="mb-3 max-w-[24ch] text-balance text-[clamp(26px,2.4vw,34px)] font-semibold leading-[1.06] tracking-[-0.035em]">
            Experience <span className="text-jaw-blue">your users&apos;</span> journey
          </h1>
          <p className="text-ink-2 mb-[26px] max-w-[600px] text-pretty text-[17px] leading-[1.55]">
            A social feed, a bill split, an AI agent. Three different designs, one invisible SDK, paid in EURe. Every
            action settles onchain.
          </p>
          <div className="relative mb-8 flex flex-col gap-2" data-analytics-surface="feature-list">
            {FEATS.map((f) => (
              <FeatRow
                key={f.id}
                f={f}
                on={id === f.id}
                past={f.id < id}
                vi={id === f.id ? vi : 0}
                setVi={pickVariant}
                onPick={() => pick(f.id)}
              />
            ))}
            <a
              className="group relative z-[1] grid cursor-pointer grid-cols-[24px_1fr] items-start gap-[18px] text-inherit no-underline"
              href="https://playground.jaw.id/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <div className="text-ink-4 group-hover:text-jaw-blue pt-[13px] font-mono text-[13px] transition-colors duration-[250ms]">
                +
              </div>
              <div className="border-line group-hover:border-line-2 group-hover:bg-raise rounded-xl border px-4 py-[13px] transition-colors duration-200">
                <div className="flex items-center gap-3">
                  <span className="text-ink-3 group-hover:text-jaw-blue shrink-0 whitespace-nowrap text-[16px] font-medium leading-[1.3] transition-colors duration-[220ms]">
                    Run it yourself
                  </span>
                  <span className="text-ink-3 group-hover:text-jaw-blue ml-auto inline-flex min-w-0 items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] uppercase tracking-[.1em] transition-colors duration-[220ms]">
                    Playground <Icon.ArrowUR size={10} />
                  </span>
                </div>
              </div>
            </a>
          </div>
          {/* Mirror the rows' [24px_1fr] grid with an empty gutter cell so the
              CTAs line up with the boxes, not the step numbers, and stay lined
              up if that column geometry ever changes. */}
          <div className="grid grid-cols-[24px_1fr] gap-[18px]">
            <div aria-hidden />
            <div className="flex flex-wrap items-center gap-3" data-analytics-surface="stage">
              {fin && (
                <span className="animate-jd-fade text-ink-2 text-[14px]">
                  Still not convinced? The docs will change that.
                </span>
              )}
              {!fin && (
                <a href="https://dashboard.jaw.id" className={btnPrimary}>
                  Dashboard <Icon.Arrow size={12} />
                </a>
              )}
              <a href="https://docs.jaw.id" target="_blank" rel="noopener noreferrer" className={btnGhost}>
                Docs <Icon.ArrowUR size={11} />
              </a>
            </div>
          </div>
        </div>

        <div className="sticky top-3 mb-7 mr-7 mt-1.5 flex flex-col gap-4 max-[1040px]:static max-[1040px]:mx-6 max-[1040px]:mb-6 max-[1040px]:mt-0">
          <div
            className="bg-raise flex flex-col items-center justify-center rounded-[28px] px-8 py-6"
            style={{
              backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(15,23,42,.07) 1px, transparent 0)',
              backgroundSize: '22px 22px',
            }}
          >
            {/* Hint above the phone. It fades rather than unmounts: dropping it
                would change the stage height and make usePhoneFit re-measure,
                resizing the phone every time a dialog opens. */}
            <span
              aria-hidden={open || fin || undefined}
              className={`border-line text-ink-2 mb-3 inline-flex items-center gap-[7px] rounded-full border bg-white px-3.5 py-[7px] font-mono text-[9.5px] uppercase tracking-[.14em] transition-opacity duration-300 ${
                open || fin ? 'opacity-0' : 'opacity-100'
              }`}
            >
              <span className="animate-hd-live bg-jaw-blue h-[5px] w-[5px] rounded-full" />
              Tap the button to continue
            </span>
            <div ref={areaRef} className="flex w-full justify-center">
              <div className="shrink-0" style={{ width: frameW * scale, height: frameH * scale }}>
                <div className="origin-top-left" style={{ transform: `scale(${scale})` }}>
                  <IOSDevice width={phoneW} height={phoneH} dark={darkScreen} screenRef={setScreenEl}>
                    {!isMobile && demo}
                  </IOSDevice>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

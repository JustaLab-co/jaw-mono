/**
 * Stable analytics names for the demo's three features. Deliberately decoupled
 * from the copy in `features.ts` — renaming a headline must not break a funnel.
 */
export type FeatureName = 'sign-in' | 'send' | 'agent-delegation';

/** Which SDK surface the event originated from. The demo only uses core. */
export type SdkType = 'core';

/** JAW connection mode, as a stable analytics string. */
export type ModeName = 'cross-platform';

/** How keys.jaw.id is reached in CrossPlatform mode. */
export type TransportName = 'popup' | 'iframe';

/**
 * Which device the tour is running on: on phones the visitor's own device IS
 * the demo phone (full-bleed, fronted by the intro), on desktop the demo runs
 * inside the mock frame. The two journeys differ enough to always slice by.
 */
export type SurfaceName = 'mobile' | 'desktop';

/**
 * Where an outbound CTA lives. Read off the nearest
 * `data-analytics-surface` ancestor by the delegated click listener in
 * AnalyticsProvider, so a dashboard click from the finale sheet is
 * distinguishable from one in the header.
 */
export type CtaSurface = 'header' | 'mobile-intro' | 'mobile-menu' | 'finale' | 'feature-list' | 'stage' | 'page';

/** Shared shape of every event fired from inside a feature screen. */
export interface FeatureContext {
  feature: FeatureName;
  /** Position in the tour (1-3), so drop-off is orderable without a lookup. */
  featureId: number;
  /** Variant key of the active screen (`happy`). */
  variant: string;
}

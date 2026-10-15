import type { FeatureName } from '../types';

export const DEMO_VARIANT_SELECTED = 'DEMO_VARIANT_SELECTED';

/**
 * Fired when the visitor deliberately switches variant. Every feature has a
 * single path today, so this only fires again if variants come back.
 */
export interface DemoVariantSelectedPayload {
  feature: FeatureName;
  featureId: number;
  variant: string;
}

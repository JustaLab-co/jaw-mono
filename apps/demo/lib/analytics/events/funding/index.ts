/**
 * /api/fund tops fresh accounts up with testnet EURe after sign-up. It is the
 * demo's one server dependency and a silent failure breaks every later screen
 * (send has nothing to spend), so its outcome is tracked separately from the
 * wallet action that triggered it.
 */
export const DEMO_FUNDING_SETTLED = 'DEMO_FUNDING_SETTLED';
export const DEMO_FUNDING_FAILED = 'DEMO_FUNDING_FAILED';

export interface DemoFundingSettledPayload {
  /** `skipped` = the account already held enough to finish the tour. */
  outcome: 'funded' | 'skipped';
}

export interface DemoFundingFailedPayload {
  message: string;
}

export const FUNDING_EVENTS = {
  DEMO_FUNDING_SETTLED,
  DEMO_FUNDING_FAILED,
} as const;

export interface FundingEventPayload {
  [DEMO_FUNDING_SETTLED]: DemoFundingSettledPayload;
  [DEMO_FUNDING_FAILED]: DemoFundingFailedPayload;
}

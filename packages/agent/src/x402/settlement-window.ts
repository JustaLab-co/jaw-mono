import type { X402PaymentRequirement } from './types.js';

/**
 * The authorization must stay valid until the facilitator's settlement is
 * MINED. Servers advertise timeouts as low as 60s, which is not enough for
 * verify, submit and a block.
 */
export const SETTLEMENT_WINDOW_FLOOR = 600;

/**
 * The server picks maxTimeoutSeconds too, and the window decides how long a
 * signed authorization stays spendable and held against the budget. A shorter
 * deadline is still within the server's maximum, so a larger ask is capped,
 * not refused. An hour is generous for verify, submit and mine.
 */
const SETTLEMENT_WINDOW_CEILING = 3600;

/** Seconds a signed authorization stays valid for: the server's ask, between the floor and the ceiling. */
export const settlementWindow = (requirement: X402PaymentRequirement): number =>
  Math.min(Math.max(requirement.maxTimeoutSeconds || 0, SETTLEMENT_WINDOW_FLOOR), SETTLEMENT_WINDOW_CEILING);

import type { X402Policy } from '../x402/policy.js';

export type PaymasterConfig = {
  url: string;
  context?: Record<string, unknown>;
};

export interface PermissionsConfig {
  /**
   * `functionSignature` is the readable form the docs use and what the SDK
   * prefers, computing the selector from it when no explicit `selector` is
   * given. Both were already accepted on the wire; only the type omitted it.
   */
  calls?: Array<{ target: string; selector?: string; functionSignature?: string }>;
  spends?: Array<{
    token: string;
    allowance: string;
    unit: string;
    multiplier?: number;
  }>;
}

export interface JawConfig {
  /** The key the user chose, by flag or by `config set`. Never written by us. */
  apiKey?: string;
  /**
   * The key the browser bridge handed us, belonging to a workspace created for
   * the CLI. Kept apart from the user's so it can be replaced on every connect:
   * a rotated key on the deployment has to reach installs that already have one,
   * and it cannot if we treat what we were handed as the user's own choice.
   *
   * Not settable, and never asserted to the browser.
   */
  workspaceApiKey?: string;
  defaultChain?: number;
  keysUrl?: string;
  ens?: string;
  relayUrl?: string;
  paymasters?: Record<number, PaymasterConfig>;
  permissions?: PermissionsConfig;
  sessionExpiry?: number;
  /**
   * The most any grant made from this machine may ask for, as
   * `<amount>/<period>` (e.g. `10/day`). Set by a human at a terminal and
   * deliberately absent from the MCP config tool, like the x402 caps: an agent
   * with shell access can already run `session setup --x402 --limit`, and
   * without this the browser screen is the only check on the number it picks.
   */
  grantCeiling?: string;
  /** x402 agentic-payment caps + allowlists (used by `jaw_pay_and_fetch`). */
  x402?: X402Policy;
  /** @deprecated Use `paymasters` instead. Auto-migrated on load. */
  paymasterUrl?: string;
}

/**
 * Config keys settable from a plain string value (`jaw config set`, jaw_config_set).
 * Excludes structured fields like `x402`/`paymasters`/`permissions`. Kept as a
 * narrow union rather than `keyof JawConfig` so it stays independent of those
 * object fields (which otherwise blow up the MCP SDK's tool-handler inference).
 */
export type SettableConfigKey =
  | 'apiKey'
  | 'defaultChain'
  | 'keysUrl'
  | 'ens'
  | 'relayUrl'
  | 'sessionExpiry'
  | 'grantCeiling';

export type OutputFormat = 'json' | 'human';

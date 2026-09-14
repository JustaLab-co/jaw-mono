import type { JawConfig } from './types.js';

/**
 * The api key a command operates under.
 *
 * Two keys can be present and they are not the same thing. `apiKey` is the
 * user's own, set by flag, by `JAW_API_KEY` or by `config set`, and it always
 * wins. `workspaceApiKey` is the one the browser handed us on connect, belonging
 * to a workspace created for the CLI, and it is what an install where nobody
 * pasted anything runs on.
 *
 * Resolved in one place because the half that spends reads it too: a top-up
 * sends a userOp through the ERC-20 paymaster and the paymaster url is built
 * from this key, so a path reading `apiKey` alone quietly refuses to refill the
 * payer on exactly the installs the injected key exists for.
 */
export function apiKeyFor(config: JawConfig, chosen?: string): string | undefined {
  return chosen ?? process.env['JAW_API_KEY'] ?? config.apiKey ?? config.workspaceApiKey;
}

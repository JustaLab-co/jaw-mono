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

/**
 * Whether an error is the proxy refusing the key it was given.
 *
 * Every proxy route answers a bad key with a 403 whose body names
 * `ApiKeyInvalidException`. Core's REST client keeps that text as the message.
 * viem's transport drops the body and keeps only the status, so a bare 403 is
 * taken as the same refusal: the key only ever goes to the proxy, and a 403
 * from anywhere else costs one refresh before the error surfaces unchanged.
 * Either can arrive wrapped by whatever was running, hence the walk down
 * `cause`.
 */
export function isRejectedApiKey(err: unknown): boolean {
  let node: unknown = err;
  while (node instanceof Error) {
    if (node.message.includes('ApiKeyInvalidException')) return true;
    const { status, cause } = node as { status?: unknown; cause?: unknown };
    if (status === 403) return true;
    node = cause;
  }
  return false;
}

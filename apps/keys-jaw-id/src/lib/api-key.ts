/**
 * The api key a request carries: the one handed in, or the one keys can read off
 * the rpc url the dApp sent, and undefined when it carries none.
 *
 * Undefined rather than '', which is what six copies of this block spelled it as.
 * A keyless session has no key anywhere, and everything downstream takes it
 * optional, so an empty string is a key that is present and empty in the only
 * place it still reads as one.
 */
export function apiKeyFromChain(apiKey: string | undefined, rpcUrl: string | undefined): string | undefined {
  if (apiKey) return apiKey;
  if (!rpcUrl) return undefined;
  try {
    // `||`, not `??`: `api-key=` with nothing after it is a url that carries no
    // key, and the proxy reads it as a malformed one rather than as absent.
    return new URL(rpcUrl).searchParams.get('api-key') || undefined;
  } catch {
    // A url keys could not parse says nothing about a key.
    return undefined;
  }
}

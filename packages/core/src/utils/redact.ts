/**
 * The error as text with any `api-key` query value masked. Our RPC, bundler and
 * paymaster urls carry the key, and viem errors print the url they failed on.
 */
export function withoutApiKey(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/api-key=[^&\s"']+/g, 'api-key=***');
}

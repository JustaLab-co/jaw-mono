/**
 * The error as text with any `api-key`, `apikey` or `api_key` query value
 * masked, in any case. Our RPC, bundler and paymaster urls carry the key, a
 * custom paymaster url may use another name, and viem errors print the url.
 */
export function withoutApiKey(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/(api[-_]?key=)[^&\s"']+/gi, '$1***');
}

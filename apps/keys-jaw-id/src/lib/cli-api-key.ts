/**
 * Which api key the CLI bridge operates under.
 *
 * A CLI that brought its own always keeps it, so anyone who wants their own
 * attribution or their own limits sets one and nothing about their setup
 * changes. Only the empty case is filled in, and the fallback is not even
 * fetched otherwise.
 *
 * The fallback belongs to a workspace created for the CLI, served by this app's
 * own route so that rotating it is an environment change rather than a rebuild.
 */
export type ApiKeyReader = () => Promise<string>;

/** Reads the CLI workspace key from this app's route, empty on any failure. */
export const fetchCliApiKey: ApiKeyReader = async () => {
  try {
    const response = await fetch('/api/cli-key', { cache: 'no-store' });
    if (!response.ok) return '';
    const body = (await response.json()) as { apiKey?: string };
    return body.apiKey ?? '';
  } catch {
    // Empty rather than a throw: the caller turns this into the error the user
    // reads, and a deployment with nothing configured is not a crash.
    return '';
  }
};

export async function resolveBridgeApiKey(sent: unknown, read: ApiKeyReader = fetchCliApiKey): Promise<string> {
  if (typeof sent === 'string' && sent.length > 0) return sent;
  return await read();
}

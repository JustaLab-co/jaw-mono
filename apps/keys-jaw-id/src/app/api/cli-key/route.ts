/**
 * The api key the CLI operates under when it brought none of its own.
 *
 * It belongs to a workspace created for the CLI, so usage attributes there
 * rather than to the keys app's own project, which bills and issues ENS
 * subnames for something else entirely. That misattribution is the reason the
 * bridge refused an empty key instead of falling back before this existed.
 *
 * Read from the environment per request rather than compiled in, which is the
 * whole reason this is a route and not a `NEXT_PUBLIC_*` value: rotating the key
 * is then an environment change instead of a rebuild, and it stays out of a
 * bundle anyone can grep.
 *
 * It is not a secret. Anyone can open this route, and nothing here can tell a
 * CLI from a curl, so the key attributes and authorises nothing. What bounds it
 * is the limit on what a caller holding it may read. Same origin only for that
 * reason: the exposure we accept is somebody who loads keys.jaw.id, not any
 * page on the web harvesting it from its own JavaScript.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const apiKey = process.env.JAW_CLI_API_KEY;

  // Loudly, because the alternative is a bridge that silently operates with no
  // key and fails later against the proxy, naming none of this.
  if (!apiKey) {
    return Response.json({ error: 'JAW_CLI_API_KEY is not configured' }, { status: 503 });
  }

  return Response.json(
    { apiKey },
    {
      headers: {
        // Rotation is the point of reading this per request, so nothing may
        // hold a copy between the change and the next connect.
        'Cache-Control': 'no-store',
      },
    }
  );
}

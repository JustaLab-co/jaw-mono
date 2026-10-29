import { BRIDGE_CLIENT_PATTERN } from '../../../lib/bridge-frames';

export const dynamic = 'force-dynamic';

/**
 * Counts which client opens the bridge. The value is self-reported, so it is
 * only ever logged, never used to decide anything, and nothing that identifies
 * the session or the person goes in the line.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) return new Response(null, { status: 400 });

  const body = await request.json().catch(() => null);
  const client = body?.client;
  if (typeof client !== 'string' || !BRIDGE_CLIENT_PATTERN.test(client)) return new Response(null, { status: 400 });

  console.info(JSON.stringify({ msg: 'bridge client', client }));
  return new Response(null, { status: 204 });
}

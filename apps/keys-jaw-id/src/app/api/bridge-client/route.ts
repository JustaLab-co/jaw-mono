import { BRIDGE_CLIENT_PATTERN } from '../../../lib/bridge-frames';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 256;

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 });

  if (Number(request.headers.get('content-length')) > MAX_BYTES) return new Response(null, { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BYTES) return new Response(null, { status: 413 });

  const body = parseJson(text);
  const client = body?.client;
  if (typeof client !== 'string' || !BRIDGE_CLIENT_PATTERN.test(client)) return new Response(null, { status: 400 });

  console.info(JSON.stringify({ msg: 'bridge client', client }));
  return new Response(null, { status: 204 });
}

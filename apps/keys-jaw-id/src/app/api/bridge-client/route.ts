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

async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 });

  if (Number(request.headers.get('content-length')) > MAX_BYTES) return new Response(null, { status: 413 });
  const text = await readCapped(request.body);
  if (text === null) return new Response(null, { status: 413 });

  const body = parseJson(text);
  const client = body?.client;
  if (typeof client !== 'string' || !BRIDGE_CLIENT_PATTERN.test(client)) return new Response(null, { status: 400 });

  console.warn(JSON.stringify({ msg: 'bridge client', client }));
  return new Response(null, { status: 204 });
}

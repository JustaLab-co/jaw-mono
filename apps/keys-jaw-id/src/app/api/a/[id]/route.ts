import { createHash, timingSafeEqual } from 'node:crypto';
import { linkKv, type Kv } from '../../../../lib/link-kv';
import { SHORT_LINK_ID } from '../../../../lib/short-link';

/**
 * The store behind short owner links. A listed MCP server writes a sealed blob once under a random id; anyone may read
 * it back until it expires. The key that opens a blob never comes here, so nothing this route sees opens a session.
 */
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 2048;
const MAX_BLOB_CHARS = 1024;
const MAX_TTL_MS = 60 * 60_000;
const BLOB = /^[A-Za-z0-9_-]+$/;
const WRITES_PER_MINUTE = 300;
const WRITES_PER_HOUR = 5000;
const READS_PER_MINUTE = 60;

type Context = { params: Promise<{ id: string }> };
/** What the store holds under `link:<id>`. A deleted link keeps its key, retired, so its id is never written again. */
type Entry = { blob: string; expiresAt: number; writer: string } | { retired: true };

const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const answer = (status: number) => new Response(null, { status, headers: HEADERS });

export async function PUT(request: Request, { params }: Context) {
  const writer = writerOf(request);
  if (!writer) return logged('PUT', 401, null);
  const status = await put(request, (await params).id, writer);
  return logged('PUT', status, writer);
}

export async function DELETE(request: Request, { params }: Context) {
  const writer = writerOf(request);
  if (!writer) return logged('DELETE', 401, null);
  const { id } = await params;
  // An id no writer could have stored costs no store call.
  if (!SHORT_LINK_ID.test(id)) return logged('DELETE', 204, writer);
  const status = await withStore(async (kv) => {
    if (await overWriteBudget(kv, writer)) return 429;
    const entry = entryOf(await kv.get(`link:${id}`));
    if (!entry || 'retired' in entry) return 204;
    if (entry.writer !== writer) return 403;
    await kv.replace(`link:${id}`, JSON.stringify({ retired: true } satisfies Entry));
    return 204;
  });
  return logged('DELETE', status, writer);
}

export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  if (!SHORT_LINK_ID.test(id)) return answer(404);
  let blob: string | undefined;
  const status = await withStore(async (kv) => {
    const minute = Math.floor(Date.now() / 60_000);
    if ((await kv.count(`rl:read:${clientIp(request)}:${minute}`, 120)) > READS_PER_MINUTE) return 429;
    const entry = entryOf(await kv.get(`link:${id}`));
    // The store's own expiry may lag, so the deadline is checked again here.
    if (!entry || 'retired' in entry || entry.expiresAt <= Date.now()) return 404;
    blob = entry.blob;
    return 200;
  });
  if (blob === undefined) return answer(status);
  return Response.json({ blob }, { headers: HEADERS });
}

async function put(request: Request, id: string, writer: string): Promise<number> {
  const text = await readCapped(request.body);
  if (text === null) return 413;
  const body = parseJson(text);
  const blob = body?.blob;
  const expiresAt = instantOf(body?.expiresAt);
  if (typeof blob === 'string' && blob.length > MAX_BLOB_CHARS) return 413;
  if (!SHORT_LINK_ID.test(id) || typeof blob !== 'string' || !BLOB.test(blob)) return 422;
  const now = Date.now();
  if (!(expiresAt > now && expiresAt <= now + MAX_TTL_MS)) return 422;

  return withStore(async (kv) => {
    if (await overWriteBudget(kv, writer)) return 429;
    // Create only: a retry with the same body is the same write, anything else would replace a live link.
    const value = JSON.stringify({ blob, expiresAt, writer } satisfies Entry);
    if (await kv.setIfAbsent(`link:${id}`, value, expiresAt)) return 200;
    return (await kv.get(`link:${id}`)) === value ? 200 : 409;
  });
}

/** Writes and deletes share one budget per writer, in fixed windows of a minute and an hour. */
async function overWriteBudget(kv: Kv, writer: string): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const hour = Math.floor(minute / 60);
  const [perMinute, perHour] = await Promise.all([
    kv.count(`rl:${writer}:m:${minute}`, 120),
    kv.count(`rl:${writer}:h:${hour}`, 7200),
  ]);
  return perMinute > WRITES_PER_MINUTE || perHour > WRITES_PER_HOUR;
}

const entryOf = (stored: string | null) => (stored ? (JSON.parse(stored) as Entry) : undefined);

/** Milliseconds for a UTC timestamp in the exact form `toISOString` writes, so no date rolls over into another. */
function instantOf(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}

async function withStore(work: (kv: Kv) => Promise<number>): Promise<number> {
  try {
    return await work(linkKv());
  } catch {
    return 503;
  }
}

/**
 * The label of the writer whose token this request carries. `KEYS_LINK_WRITERS` lists `label:sha256hex` entries, so
 * this app's own environment holds no token that could write.
 */
function writerOf(request: Request): string | undefined {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return undefined;
  const presented = createHash('sha256').update(token).digest();
  let found: string | undefined;
  for (const entry of (process.env.KEYS_LINK_WRITERS ?? '').split(',')) {
    const [label, hex] = entry.trim().split(':');
    if (!label || !/^[0-9a-f]{64}$/.test(hex ?? '')) continue;
    // Every entry is compared, so the time taken does not tell which one matched.
    if (timingSafeEqual(presented, Buffer.from(hex, 'hex'))) found ??= label;
  }
  return found;
}

/** One line per write or delete: method, status and writer. Never the body, the blob or the Authorization header. */
function logged(method: string, status: number, writer: string | null) {
  console.warn(JSON.stringify({ msg: 'short link', method, status, writer }));
  return answer(status);
}

const clientIp = (request: Request) =>
  request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';

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
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

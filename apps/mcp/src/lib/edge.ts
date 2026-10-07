import { countHit, isPaused } from '@/db/settings';

type Handler = (req: Request) => Response | Promise<Response>;

export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT = 120;

function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

async function refuse(req: Request): Promise<Response | undefined> {
  if (await isPaused()) return Response.json({ error: 'paused' }, { status: 503 });
  const hits = await countHit(`ip:${clientIp(req)}`, RATE_WINDOW_MS);
  if (hits > RATE_LIMIT) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '60' } });
  }
  return undefined;
}

// Wraps a route: a request id on every response and one log line per request.
// Guarded routes also honour the kill switch and the per-IP rate limit.
export function withEdge(handler: Handler, { guarded }: { guarded: boolean }): (req: Request) => Promise<Response> {
  return async (req) => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    let res: Response;
    try {
      res = (guarded && (await refuse(req))) || (await handler(req));
    } catch (err) {
      log('error', { requestId, error: err instanceof Error ? err.message : String(err) });
      res = Response.json({ error: 'internal_error', requestId }, { status: 500 });
    }
    const out = new Response(res.body, res);
    out.headers.set('x-request-id', requestId);
    log('info', {
      requestId,
      method: req.method,
      path: new URL(req.url).pathname,
      status: out.status,
      ms: Math.round(performance.now() - started),
    });
    return out;
  };
}

// Never pass a token, key, query string or request body here.
export function log(level: 'info' | 'error', fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), ...fields }));
}
